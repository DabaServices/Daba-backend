import { Op, WhereOptions } from "sequelize";
import { REPORTABLE_UNIT_TYPES, UNIT_LEVELS, UNIT_TYPES } from "../../../constants";
import { IUnit } from "./unit.model";

export const getReportableUnitTypeWhere = (): WhereOptions<IUnit> => ({
    [Op.or]: [{
        [Op.and]: [
            { unitTypeId: { [Op.in]: REPORTABLE_UNIT_TYPES } },
            { unitLevelId: { [Op.notIn]: [UNIT_LEVELS.COMPANY, UNIT_LEVELS.GDUD] } }
        ],
    },
    {
        [Op.and]: [
            { unitTypeId: UNIT_TYPES.EMERGENCY },
            { unitLevelId: { [Op.in]: [UNIT_LEVELS.GDUD, UNIT_LEVELS.COMPANY] } }
        ]
    }],
});
