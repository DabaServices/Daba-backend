import { Op, WhereOptions } from "sequelize";
import { OBJECT_TYPES, REPORTABLE_UNIT_TYPES } from "../../../constants";
import { IUnit } from "./unit.model";

/**
 * Limits `units` rows to the reportable unit types. `unit_type_id` is only populated
 * for frames, so companies are matched on their object type alone. Wrapped in `Op.and`
 * so it can be spread next to a where clause that already uses `Op.or`.
 */
export const getReportableUnitTypeWhere = (): WhereOptions<IUnit> => ({
    [Op.and]: [{
        [Op.or]: [
            { objectType: { [Op.ne]: OBJECT_TYPES.UNIT } },
            { unitTypeId: { [Op.in]: REPORTABLE_UNIT_TYPES } },
        ],
    }],
});
