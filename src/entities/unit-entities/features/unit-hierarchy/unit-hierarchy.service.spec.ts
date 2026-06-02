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
});

const buildRelation = (unitId: number, relatedUnitId: number) => ({
  unitId,
  relatedUnitId,
});

const buildService = ({
  unitDetails,
  relations,
}: {
  unitDetails: ReturnType<typeof buildUnitDetail>[];
  relations: ReturnType<typeof buildRelation>[];
}) => {
  const repository = {
    fetchAllActiveUnitDetails: jest.fn().mockResolvedValue(unitDetails),
    fetchDirectParentRelations: jest.fn().mockResolvedValue(relations),
    fetchUnitStatusesForDate: jest.fn().mockResolvedValue([]),
  };

  return {
    repository,
    service: new UnitHierarchyService(
      repository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ),
  };
};

describe('UnitHierarchyService', () => {
  describe('getLowerLevelUnitsConnection', () => {
    it('returns lower-level units with recursive connection to the screen unit', async () => {
      const { service } = buildService({
        unitDetails: [
          buildUnitDetail(1, 'Root', 0),
          buildUnitDetail(2, 'Screen', 1),
          buildUnitDetail(3, 'Direct child', 2),
          buildUnitDetail(4, 'Grandchild', 3),
          buildUnitDetail(5, 'Disconnected lower unit', 2),
          buildUnitDetail(6, 'Another parent', 1),
        ],
        relations: [
          buildRelation(1, 2),
          buildRelation(2, 3),
          buildRelation(3, 4),
          buildRelation(6, 5),
        ],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 2),
      ).resolves.toEqual([
        {
          id: 3,
          description: 'Direct child',
          level: 2,
          simul: '3',
          isConnectedToRoot: true,
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
        unitDetails: [
          buildUnitDetail(2, 'Screen', 1),
          ...Array.from({ length: 12 }, (_, index) =>
            buildUnitDetail(10 + index, `Lower ${index}`, 2),
          ),
        ],
        relations: [],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 2, { limit: 50 }),
      ).resolves.toHaveLength(10);
    });

    it('rejects a missing screen unit', async () => {
      const { service } = buildService({
        unitDetails: [buildUnitDetail(1, 'Root', 0)],
        relations: [],
      });

      await expect(
        service.getLowerLevelUnitsConnection('2026-06-02', 0),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
