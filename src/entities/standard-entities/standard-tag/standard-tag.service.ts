import { BadGatewayException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { StandardTagRepository } from "./standard-tag.repository";
import { CreateTagDTO, UpdateTagDTO } from "./standard-tag.types";
import { IStandardTag } from "./standard-tag.model";
import { MESSAGE_TYPES } from "../../../constants";
import { isDefined, isEmptyish, isNullish } from "remeda";
import { StandardValuesRepository } from "../standard-values/standard-values.repository";

@Injectable()
export class StandardTagService {
    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly repository: StandardTagRepository,
        private readonly standardValuesRepository: StandardValuesRepository
    ) { }

    async createTag(createTag: CreateTagDTO) {
        try {
            const existingTagByDescription = await this.repository.fetchByDescription(createTag.tag,
                createTag.tagGroupId)

            if (!isNullish(existingTagByDescription)) {
                throw new BadGatewayException({
                    message: 'התגית קיימת לרמה הארגונית תחת קבוצה זו',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            await this.sequelize.transaction((transaction) =>
                this.repository.createTag(createTag as IStandardTag, transaction));

            return {
                message: 'התגית נוצרה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error: any) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? `התגית לא נוצרה, יש לנסות שוב`,
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async updateTag(updateTag: UpdateTagDTO) {
        try {
            const existingTag = await this.repository.fetchByDescription(updateTag.tag,
                updateTag.tagGroupId)

            if (isDefined(existingTag) && existingTag?.dataValues.tag === updateTag.tag
                && existingTag.dataValues.unitLevel === updateTag.unitLevel) {
                throw new BadGatewayException({
                    message: 'התגית לא עודכנה, יש לבטל את הפעולה',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            await this.sequelize.transaction((transaction) =>
                this.repository.updateTag(updateTag, transaction));

            return {
                message: 'התגית עודכנה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error: any) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? `התגית לא עודכנה, יש לנסות שוב`,
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async deleteTag(id: number) {
        try {
            const standardValues = await this.standardValuesRepository.fetchByTagId(id);

            if (!isEmptyish(standardValues)) {
                throw new BadGatewayException({
                    message: 'לא ניתן למחוק את התגית, קיימים ערכי תקינה מקושרים',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            await this.sequelize.transaction((transaction) => this.repository.deleteTag(id, transaction));

            return {
                message: 'התגית נמחקה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            };
        } catch (error: any) {
            throw new BadGatewayException({
                message: error?.response?.message ?? 'לא היה ניתן למחוק את התגית',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }
}