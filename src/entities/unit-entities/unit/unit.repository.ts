import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Op } from "sequelize";
import { OBJECT_TYPES } from "../../../constants";
import { getReportableUnitTypeWhere } from "./unit-query.utils";
import { IUnit, Unit } from "./unit.model";

export type ActiveUnitDetails = Pick<IUnit, "unitId" | "unitLevelId" | "startDate">;

@Injectable()
export class UnitRepository {
    constructor(@InjectModel(Unit) private readonly unitModel: typeof Unit) { }

    async fetchActiveUnitDetails(date: string | Date, unitId: number): Promise<ActiveUnitDetails | null> {
        const unitDetails = await this.unitModel.findOne({
            attributes: ["unitId", "unitLevelId", "startDate"],
            where: {
                unitId,
                objectType: OBJECT_TYPES.UNIT,
                startDate: { [Op.lte]: date },
                endDate: { [Op.gt]: date },
                ...getReportableUnitTypeWhere(),
            },
            order: [["startDate", "DESC"]],
            raw: true,
        });

        return unitDetails as ActiveUnitDetails | null;
    }
}
