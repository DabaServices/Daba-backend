import { Injectable } from "@nestjs/common";
import { isEmpty, omit } from "remeda";
import { Transaction, WhereOptions } from "sequelize";
import { SYNC_ACTIONS, SYNC_SUPPRESS } from "./sync.constants";
import { SyncSchemaRegistry } from "./sync-schema.registry";
import { SyncOperation } from "./sync.types";

type WriteOptions = Record<string, unknown>;

/** Sequelize is fully typed against concrete models; the executor is generic by design, so it talks to this narrow view. */
type WritableModel = {
    upsert(values: Record<string, unknown>, options: WriteOptions): Promise<unknown>;
    update(values: Record<string, unknown>, options: WriteOptions & { where: WhereOptions }): Promise<unknown>;
    destroy(options: WriteOptions & { where: WhereOptions }): Promise<number>;
};

/**
 * Replays a batch onto the local tables, in the order the source produced it. Every statement runs
 * on the caller's transaction, so the batch is all-or-nothing, and every statement is flagged as a
 * replay so the capture hooks do not send it straight back.
 */
@Injectable()
export class SyncExecutorService {
    constructor(private readonly registry: SyncSchemaRegistry) { }

    async run(operations: SyncOperation[], transaction: Transaction): Promise<void> {
        for (const operation of operations) {
            const model = this.registry.modelOf(operation.table) as unknown as WritableModel;
            const values = this.registry.toAttributes(operation.table, operation.data);
            const base: WriteOptions = { transaction, [SYNC_SUPPRESS]: true };

            switch (operation.action) {
                case SYNC_ACTIONS.UPSERT: {
                    await model.upsert(values, {
                        ...base,
                        // `fields` is what Sequelize writes on conflict, mirroring the source statement exactly.
                        ...(operation.update_fields
                            ? { fields: this.registry.toAttributeNames(operation.table, operation.update_fields) }
                            : {}),
                        ...(operation.conflict_fields ? { conflictFields: operation.conflict_fields } : {})
                    });
                    break;
                }

                case SYNC_ACTIONS.UPDATE: {
                    const where = this.registry.primaryKeyValues(operation.table, values);
                    const changes = omit(values, Object.keys(where));
                    if (isEmpty(changes)) break;

                    await model.update(changes, { ...base, where });
                    break;
                }

                case SYNC_ACTIONS.DELETE: {
                    await model.destroy({ ...base, where: this.registry.primaryKeyValues(operation.table, values) });
                    break;
                }
            }
        }
    }
}
