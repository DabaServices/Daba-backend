import { Body, Controller, Delete, Get, Post, Req } from '@nestjs/common';
import { RequireScreenUnitRequesting } from '../../../common/decorators/require-screen-unit-requesting.decorator';
import { ReportService } from './report.service';
import type {
  AggregateReportsDTO,
  DownloadAllocationsDTO,
  InventoryCalculationBody,
  ReportDto,
  SaveAllocationsDTO,
  SaveCommitteesBody,
} from './report.types';

@Controller('/reports')
export class ReportController {
  constructor(private readonly service: ReportService) {}

  @Get('')
  fetchReports(@Req() request: Request): Promise<ReportDto[]> {
    return this.service.fetchReports(
      request['date'],
      Number(request.headers['unit']),
      request['username'],
    );
  }

  @RequireScreenUnitRequesting()
  @Get('favorites')
  fetchFavoriteReports(@Req() request: Request) {
    return this.service.fetchFavoriteReports(
      request['date'],
      Number(request.headers['unit']),
    );
  }

  @RequireScreenUnitRequesting()
  @Get('recentMaterials')
  fetchMostRecentMaterials(@Req() request: Request) {
    return this.service.fetchMostRecentMaterials(
      request['date'],
      Number(request.headers['unit']),
    );
  }

  @RequireScreenUnitRequesting()
  @Post('committees/save')
  saveReportsChanges(
    @Body() saveReportsBody: SaveCommitteesBody,
    @Req() request: Request,
  ) {
    return this.service.saveReportsChanges(
      saveReportsBody,
      request['date'],
      Number(request.headers['unit']),
      request['username'],
    );
  }

  @RequireScreenUnitRequesting()
  @Post('committees/report')
  aggregateHierarchy(
    @Body() aggregatedReportsDTO: AggregateReportsDTO,
    @Req() request: Request,
  ) {
    return this.service.aggregateHierarchy(
      request['date'],
      Number(request.headers['unit']),
      request['username'],
      aggregatedReportsDTO,
    );
  }

  @Post('allocations/save')
  saveAllocations(
    @Body() saveAllocationsDTO: SaveAllocationsDTO,
    @Req() request: Request,
  ) {
    return this.service.saveAllocations(
      saveAllocationsDTO,
      request['date'],
      Number(request.headers['unit']),
      request['username'],
    );
  }

  @Post('allocations/report')
  downloadAllocations(
    @Body() downloadAllocationsDTO: DownloadAllocationsDTO,
    @Req() request: Request,
  ) {
    return this.service.downloadAllocations(
      request['date'],
      Number(request.headers['unit']),
      request['username'],
      downloadAllocationsDTO?.materialId,
    );
  }

  @Post('inventoryCalculation')
  inventoryCalculation(
    @Body() inventoryCalculationBody: InventoryCalculationBody,
    @Req() request: Request,
  ) {
    return this.service.inventoryCalculation(
      request['date'],
      Number(request.headers['unit']),
      inventoryCalculationBody?.materialsIds ?? [],
    );
  }
}
