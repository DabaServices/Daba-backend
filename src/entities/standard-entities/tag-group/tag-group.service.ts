import { BadGatewayException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { TagGroupRepository } from "./tag-group.repository";
import { ITagGroup } from "./tag-group.model";
import { MESSAGE_TYPES } from "../../../constants";
import { CreateTagGroupDTO, UpdateTagGroupDTO } from "./tag-group.types";
import { isDefined, isEmptyish, isNullish } from "remeda";
import { StandardValuesRepository } from "../standard-values/standard-values.repository";

@Injectable()
export class TagGroupService {
    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly repository: TagGroupRepository,
        private readonly standardValuesRepository: StandardValuesRepository
    ) { }

    async fetchAll(level: number) {
        const tagsGroups = await this.repository.fetchAll(level);

        return tagsGroups.map(tagGroup => ({
            id: tagGroup.dataValues.id,
            description: tagGroup.dataValues.description,
            tags: tagGroup.tags?.map(tag => ({
                id: tag.dataValues.id,
                description: tag.dataValues.tag,
                unitLevel: tag.dataValues.unitLevel,
                units: tag.unitStandardTags.map(unitStandardTag => ({
                    id: unitStandardTag.Unit.activeDetail?.dataValues.unitId,
                    description: unitStandardTag.Unit.activeDetail?.dataValues.description
                })).sort((a, b) => a.description!.localeCompare(b.description!))
            })).sort((a, b) => {
                if (a.unitLevel === b.unitLevel)
                    return a.description.localeCompare(b.description)

                return a.unitLevel - b.unitLevel
            })
        })).sort((a, b) => a.description.localeCompare(b.description));
    }

    async createTagGroup(createTagGroupDTO: CreateTagGroupDTO) {
        try {
            const existingTag = await this.repository.fetchByDescription(createTagGroupDTO.description);

            if (!isNullish(existingTag) && !isDefined(createTagGroupDTO.id)) {
                throw new BadGatewayException({
                    message: `קבוצת התגיות ${createTagGroupDTO.description} כבר קיימת, היצירה נכשלה`
                })
            }

            await this.sequelize.transaction((transaction) =>
                this.repository.createTagGroup(createTagGroupDTO as ITagGroup, transaction));

            return {
                message: `התגית ${createTagGroupDTO.description} נשמרה בהצלחה`,
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? `נכשלה שמירת התגית ${createTagGroupDTO.description}, יש לנסות שנית`,
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async updateTagGroupDTO(updateTagGroupDTO: UpdateTagGroupDTO) {
        try {
            const existingTag = await this.repository.fetchById(updateTagGroupDTO.id);

            if (existingTag?.dataValues.description === updateTagGroupDTO.description) {
                throw new BadGatewayException({
                    message: 'קבוצת התגיות חא נערכה',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            await this.sequelize.transaction((transaction) =>
                this.repository.updateTagGroup(updateTagGroupDTO, transaction));

            return {
                message: 'קבוצת התגיות נערכה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'נכשלה עריכת התגובה, יש לנסות שנית',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }

    async deleteTagGroup(id: number) {
        try {
            const standardValueByTagGroupId = await this.standardValuesRepository.fetchByTagGroupId(id);

            if (!isEmptyish(standardValueByTagGroupId)) {
                throw new BadGatewayException({
                    message: 'לא ניתן למחוק את קבוצת התגיות, קיימים ערכי תקינה מקושרים',
                    type: MESSAGE_TYPES.FAILURE
                })
            }

            await this.sequelize.transaction((transaction) => this.repository.deleteTagGroup(id, transaction));

            return {
                message: 'קבוצת התגיות נמחקה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.log(error);

            throw new BadGatewayException({
                message: error?.response?.message ?? 'מחיקת קבוצת התגיות נכשלה, יש לנסות שנית',
                type: MESSAGE_TYPES.FAILURE
            })
        }
    }
}