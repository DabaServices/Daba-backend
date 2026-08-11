import { BadRequestException } from '@nestjs/common';
import { UnitHierarchyService } from './unit-hierarchy.service';

const buildUnitDetail = (
  unitId: number,
  description: string,
  unitLevelId: number,
) => ({
  unitId,
  description,
  unitLevelId,
  tsavIrgunCodeId: String(unitId),
  dataValues: {
    unitId,
    description,
    unitLevelId,
    tsavIrgunCodeId: String(unitId),
  },
});

const buildRelation = (unitId: number, relatedUnitId: number) => ({
  unitId,
  relatedUnitId,
});

const buildService = ({
  unitDetails,
  relations,
  rootUnitId = 1,
}: {
  unitDetails: ReturnType<typeof buildUnitDetail>[];
  relations: ReturnType<typeof buildRelation>[];
  rootUnitId?: number;
}) => {
  const repository = {
    fetchAllActiveUnitDetails: jest.fn().mockResolvedValue(unitDetails),
    fetchDirectParentRelations: jest.fn().mockResolvedValue(relations),
    fetchUnitStatusesForDate: jest.fn().mockResolvedValue([]),
  };
  const unitUserRepository = {
    fetchUnitUser: jest.fn().mockResolvedValue({
      unitId: rootUnitId,
      dataValues: { unitId: rootUnitId },
    }),
  };

  return {
    repository,
    service: new UnitHierarchyService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      unitUserRepository as any,
    ),
  };
};

describe('UnitHierarchyService', () => {
  describe('getHierarchyForUser', () => {
    it('returns only the user-root branch', async () => {
      const { repository, service } = buildService({
        rootUnitId: 100,
        unitDetails: [
          buildUnitDetail(100, 'Root', 0),
          buildUnitDetail(101, 'Connected child', 1),
          buildUnitDetail(10, 'Unconnected parent', 2),
          buildUnitDetail(11, 'Unconnected child', 4),
        ],
        relations: [
          buildRelation(100, 101),
          buildRelation(10, 11),
        ],
      });

      await expect(
        service.getHierarchyForUser('test-user', '2026-06-02'),
      ).resolves.toEqual([
        {
          id: 100,
          description: 'Root',
          level: 0,
          simul: '100',
          isConnectedToRoot: true,
          isConnectedToMatkal: false,
          isRootUnit: true,
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: null,
        },
        {
          id: 101,
          description: 'Connected child',
          level: 1,
          simul: '101',
          isConnectedToRoot: true,
          isConnectedToMatkal: false,
          isRootUnit: false,
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: {
            id: 100,
            description: 'Root',
            level: 0,
            simul: '100',
            status: { id: 0, description: 'בדיווח' },
          },
        },
      ]);
      expect(repository.fetchUnitStatusesForDate).toHaveBeenCalledWith(
        '2026-06-02',
        [100, 101],
      );
    });
  });

  describe('getLowerLevelUnitsConnection', () => {
    it('returns lower-level units with recursive connection to the screen unit', async () => {
      const { service } = buildService({
        rootUnitId: 2,
        unitDetails: [
          buildUnitDetail(6133, 'Matkal', 0),
          buildUnitDetail(1, 'Root', 0),
          buildUnitDetail(2, 'Screen', 1),
          buildUnitDetail(3, 'Direct child', 2),
          buildUnitDetail(4, 'Grandchild', 3),
          buildUnitDetail(5, 'Disconnected lower unit', 2),
          buildUnitDetail(6, 'Another parent', 1),
        ],
        relations: [
          buildRelation(6133, 2),
          buildRelation(1, 2),
          buildRelation(2, 3),
          buildRelation(3, 4),
          buildRelation(6, 5),
        ],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 'S9107544'),
      ).resolves.toEqual([
        {
          id: 3,
          description: 'Direct child',
          level: 2,
          simul: '3',
          isConnectedToRoot: true,
          isConnectedToMatkal: true,
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: {
            id: 2,
            description: 'Screen',
            level: 1,
            simul: '2',
            status: { id: 0, description: 'בדיווח' },
          },
        },
        {
          id: 5,
          description: 'Disconnected lower unit',
          level: 2,
          simul: '5',
          isConnectedToRoot: false,
          isConnectedToMatkal: false,
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: {
            id: 6,
            description: 'Another parent',
            level: 1,
            simul: '6',
            status: { id: 0, description: 'בדיווח' },
          },
        },
        {
          id: 4,
          description: 'Grandchild',
          level: 3,
          simul: '4',
          isConnectedToRoot: true,
          isConnectedToMatkal: true,
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: {
            id: 3,
            description: 'Direct child',
            level: 2,
            simul: '3',
            status: { id: 0, description: 'בדיווח' },
          },
        },
      ]);
    });

    it('limits lower-level units to ten results', async () => {
      const { service } = buildService({
        rootUnitId: 2,
        unitDetails: [
          buildUnitDetail(2, 'Screen', 1),
          ...Array.from({ length: 12 }, (_, index) =>
            buildUnitDetail(10 + index, `Lower ${index}`, 2),
          ),
        ],
        relations: [],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 'S9107544', { limit: 50 }),
      ).resolves.toHaveLength(10);
    });

    it('rejects a missing screen unit', async () => {
      const { service } = buildService({
        rootUnitId: 2,
        unitDetails: [buildUnitDetail(1, 'Root', 0)],
        relations: [],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 'S9107544'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('searchUnitsCombobox', () => {
    it('returns only descendants of the requested connected unit', async () => {
      const { repository, service } = buildService({
        unitDetails: [],
        relations: [],
      });
      const connectedUnit = buildUnitDetail(3, 'Connected', 2);
      const disconnectedUnit = buildUnitDetail(4, 'Disconnected', 2);

      (repository as any).fetchActiveUnitDetailsBySearch = jest.fn().mockResolvedValue([
        connectedUnit,
        disconnectedUnit,
      ]);
      repository.fetchDirectParentRelations.mockResolvedValue([
        buildRelation(1, 3),
        buildRelation(9, 4),
      ]);
      (repository as any).fetchActiveUnitDetailsByIds = jest.fn().mockResolvedValue([
        buildUnitDetail(1, 'Screen', 1),
        buildUnitDetail(9, 'Other parent', 1),
      ]);
      (repository as any).fetchActive = jest.fn().mockResolvedValue([
        buildRelation(1, 3),
        buildRelation(9, 4),
      ]);

      await expect(service.searchUnitsCombobox('2026-06-02', {
        filter: '',
        currentLevel: 1,
        connectedToUnitId: 1,
      })).resolves.toEqual([
        {
          id: 3,
          description: 'Connected',
          level: 2,
          simul: '3',
          isEmergencyUnit: false,
          status: { id: 0, description: 'בדיווח' },
          parent: {
            id: 1,
            description: 'Screen',
            level: 1,
            simul: '1',
            status: { id: 0, description: 'בדיווח' },
          },
        },
      ]);
    });
  });

});
