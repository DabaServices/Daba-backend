import { BadGatewayException, Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { CommentRepository } from "./comment.repository";
import { CommentDTO } from "./comment.types";
import { MESSAGE_TYPES } from "../../../constants";

@Injectable()
export class CommentService {
    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly repository: CommentRepository
    ) { }

    async postComment(comment: CommentDTO) {
        try {
            await this.sequelize.transaction((transaction) =>
                this.repository.postComment({
                    ...comment,
                    date: new Date(comment.date)
                }, transaction));

            return {
                message: 'ההודעה נשמרה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.error('Error posting comment:', error);
            throw new BadGatewayException({
                message: 'נכשלה שמירת ההודעה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }

    async deleteComment(comment: CommentDTO) {
        try {
            await this.sequelize.transaction((transaction) =>
                this.repository.deleteComment({
                    ...comment,
                    date: new Date(comment.date)
                }, transaction));

            return {
                message: 'ההודעה נמחקה בהצלחה',
                type: MESSAGE_TYPES.SUCCESS
            }
        } catch (error) {
            console.error(error);
            throw new BadGatewayException({
                message: 'נכשלה מחיקת ההודעה, יש לנסות שוב',
                type: MESSAGE_TYPES.FAILURE
            });
        }
    }
}