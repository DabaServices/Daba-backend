import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { UnitStanadrdTagRepository } from "./unit-standard-tag.repository";
import { CreateUnitStandardTag, DeleteUnitStandardTag } from "./unit-standard-tag.types";
import { MESSAGE_TYPES } from "../../../constants";
import { isDefined } from "class-validator";
import { StandardTagRepository } from "../standard-tag/standard-tag.repository";

@Injectable()
export class UnitStandardTagService {
    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly repository: UnitStanadrdTagRepository,
        private readonly standardTagRepository: StandardTagRepository
    ) { }

    async createUnitStandardTag(createUnitStandardTag: CreateUnitStandardTag) {
        try {
            const tagLevel = await this.standardTagRepository.fetchById(createUnitStandardTag.tagId);

            const unitOnAnotherTagOnSameLevel = await this.standardTagRepository.fetchIfUnitOnAnotherTagOnSameLevel(
                createUnitStandardTag.tagId,
                tagLevel!.unitLevel,
                tagLevel!.tagGroupId,
                createUnitStandardTag.unitId
            );

            if (unitOnAnotherTagOnSameLevel) {
                throw new BadRequestException({
                    message: 'יחידה זו מחוברת לתגית מקבילה - תגית אחרת באותה קבוצת תגיות',
                    type: MESSAGE_TYPES.FAILURE
                });
            }

            const existingUnitStandardTag = await this.repository.fetchUnitStandardTag(createUnitStandardTag);

            if (isDefined(existingUnitStandardTag)) {
                throw new BadRequestException({
                    message: 'היחידה כבר תחת התגית הנוכחית, הקשר לא נוצר',
                    type: MESSAGE_TYPES.FAILURE
                });
            }
            await this.sequelize.transaction((transaction) =>
                this.repository.createUnitStandardTag(createUnitStandardTag, transaction));

            return {
                message: 'היחידה התווספה אל התגית',
                type: MESSAGE_TYPES.SUCCESS
            };
        } catch (error: any) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'היחידה לא נוספה אל התגית, יש לנסות שנית',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async removeUnitStandardTag(deleteUnitStandardTag: DeleteUnitStandardTag) {
        try {
            await this.sequelize.transaction((transaction) =>
                this.repository.removeUnitStandardTag(deleteUnitStandardTag, transaction));

            return {
                message: 'היחידה נמחקה מן התגית',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.log(error);

            throw new BadGatewayException({
                message: 'היחידה לא נמחקה מן התגית, יש לנסות שנית',
                type: MESSAGE_TYPES.FAILURE
            })

        }
    }
}