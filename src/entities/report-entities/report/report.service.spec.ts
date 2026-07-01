import { ReportService } from './report.service';

const buildService = () => {
  const repository = {
    fetchReportsData: jest.fn().mockResolvedValue([]),
    fetchAllocationReportsData: jest.fn().mockResolvedValue([]),
    fetchIncomingAllocationReports: jest.fn().mockResolvedValue([]),
    fetchStandaloneCommentsData: jest.fn().mockResolvedValue([]),
  };
  const unitHierarchyService = {
    getRootUnitIdForUser: jest.fn().mockResolvedValue(73),
  };

  return {
    repository,
    unitHierarchyService,
    service: new ReportService(
      repository as any,
      {} as any,
      unitHierarchyService as any,
      {} as any,
      {} as any,
    ),
  };
};

describe('ReportService.fetchReports', () => {
  it("resolves the user's root unit when the initial request has no screen unit", async () => {
    const { repository, service, unitHierarchyService } = buildService();

    await expect(
      service.fetchReports('2026-07-01', 0, 'S123'),
    ).resolves.toEqual([]);

    expect(unitHierarchyService.getRootUnitIdForUser).toHaveBeenCalledWith(
      'S123',
    );
    expect(repository.fetchReportsData).toHaveBeenCalledWith(
      '2026-07-01',
      73,
    );
  });

  it('uses an explicitly selected screen unit without resolving the root', async () => {
    const { repository, service, unitHierarchyService } = buildService();

    await expect(
      service.fetchReports('2026-07-01', 91, 'S123'),
    ).resolves.toEqual([]);

    expect(unitHierarchyService.getRootUnitIdForUser).not.toHaveBeenCalled();
    expect(repository.fetchReportsData).toHaveBeenCalledWith(
      '2026-07-01',
      91,
    );
  });

  it('starts the independent report reads together', async () => {
    const { repository, service } = buildService();
    let resolveBaseReports!: (value: []) => void;
    repository.fetchReportsData.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveBaseReports = resolve;
      }),
    );

    const reportsPromise = service.fetchReports('2026-07-01', 91, 'S123');

    expect(repository.fetchAllocationReportsData).toHaveBeenCalled();
    expect(repository.fetchIncomingAllocationReports).toHaveBeenCalled();
    expect(repository.fetchStandaloneCommentsData).toHaveBeenCalled();

    resolveBaseReports([]);
    await expect(reportsPromise).resolves.toEqual([]);
  });
});
