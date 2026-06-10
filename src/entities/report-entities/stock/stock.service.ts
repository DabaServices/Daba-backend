import { Injectable } from '@nestjs/common';
import { StockRepository } from './stock.repositroy';
import { UnitHierarchyService } from 'src/entities/unit-entities/features/unit-hierarchy/unit-hierarchy.service';
import { MaterialStandardGroupRepository } from 'src/entities/standard-entities/material-standard-group/material-standard-group.repository';
import {
  UNIT_LEVELS,
  MATKAL_UNIT_ID,
  MARTACH_UNIT_ID,
  UNIT_STATUSES,
} from 'src/constants';
import { isEmpty } from 'remeda';

const GRADE_GROUPS: { grades: string[]; label: string }[] = [
  { grades: ['00', '01', '02', '04'], label: '0, 1, 2, 4' },
  { grades: ['03'], label: '3' },
  { grades: ['05'], label: '5' },
  { grades: ['06', '07', '08', '09'], label: '6, 7, 8, 9' },
];

@Injectable()
export class StockService {
  constructor(
    private readonly stockRepository: StockRepository,
    private readonly unitHierarchyService: UnitHierarchyService,
    private readonly materialStandardGroupRepository: MaterialStandardGroupRepository,
  ) { }

  async getMaterialStocks(unit: Number, date: string, material?: string) {
    const rootUnitChildrenHierarchy =
      await this.unitHierarchyService.getNestedHierarchyByRootUnit(unit, date);

    const visibleChildren = rootUnitChildrenHierarchy.filter(
      (child) =>
        child.isEmergencyUnit && child.status?.id !== UNIT_STATUSES.REQUESTING,
    );

    const allRelatedUnitIds = visibleChildren.flatMap((rootUnitChild) =>
      rootUnitChild.level === UNIT_LEVELS.GDUD
        && rootUnitChild.status.id !== UNIT_STATUSES.REQUESTING
        ? rootUnitChild.id
        : rootUnitChild.children
          .filter(
            (child) =>
              child.level === UNIT_LEVELS.GDUD &&
              child.status?.id !== UNIT_STATUSES.REQUESTING,
          )
          .map((child) => child.id),
    );

    if (Number(unit) === MATKAL_UNIT_ID) {
      allRelatedUnitIds.push(MARTACH_UNIT_ID);
      visibleChildren.unshift({
        id: MARTACH_UNIT_ID,
        description: 'מרת"ח',
        level: UNIT_LEVELS.MATKAL,
        simul: '',
        isEmergencyUnit: false,
        status: { id: 0, description: '' },
        children: [
          {
            id: MARTACH_UNIT_ID,
            description: 'מרת"ח',
            level: UNIT_LEVELS.PIKUD,
            simul: '',
            isEmergencyUnit: false,
            status: { id: 0, description: '' },
          },
        ],
      });
    }

    const groupMaterials =
      await this.materialStandardGroupRepository.fetchMaterialsByGroupId(
        material || '',
      );

    const materialIds = !isEmpty(groupMaterials) ? groupMaterials : material;

    const allStocks = await this.stockRepository.getMaterialStock(
      materialIds,
      allRelatedUnitIds,
    );

    const rootUnitChildStocks = visibleChildren.map((rootUnitChild) => {
      const relatedUnitsId = new Set(
        rootUnitChild.level === UNIT_LEVELS.GDUD
          ? [rootUnitChild.id]
          : rootUnitChild.children.map((child) => child.id),
      );

      const childUnitStocks = allStocks.filter((stock) =>
        relatedUnitsId.has(stock.unitId),
      );

      const quantityByGrade = new Map<string, number>();
      for (const stock of childUnitStocks) {
        const grade = stock.stockType === 1 ? 'Ashrot' : stock.grade;
        const quantity = Number(stock.quantity) || 0;
        quantityByGrade.set(
          grade,
          (quantityByGrade.get(grade) ?? 0) + quantity,
        );
      }

      const stocks: { grade: string; quantity: number }[] = [];

      for (const group of GRADE_GROUPS) {
        const quantity = group.grades.reduce(
          (sum, grade) => sum + (quantityByGrade.get(grade) ?? 0),
          0,
        );
        stocks.push({ grade: group.label, quantity });
      }

      const ashrotQuantity = quantityByGrade.get('Ashrot') ?? 0;
      stocks.push({ grade: 'Ashrot', quantity: ashrotQuantity });

      const totalStocksQuantity = stocks
        .filter((stock) => stock.grade !== 'Ashrot')
        .reduce((sum, stock) => sum + stock.quantity, 0);

      return {
        id: rootUnitChild.id,
        description: rootUnitChild.description,
        stocks,
        totalStocksQuantity,
      };
    });

    return rootUnitChildStocks;
  }
}
