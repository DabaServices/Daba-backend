import { Injectable, InternalServerErrorException, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { randomUUID } from "node:crypto";
import { isNonNullish } from "remeda";
import { Model, ModelStatic, Transaction } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { SyncConfig } from "./sync.config";
import { OUTBOX_STATUSES, SYNC_ACTIONS, SYNC_BATCH_ID, SYNC_SUPPRESS } from "./sync.constants";
import { SyncOutboxRepository } from "./sync-outbox.repository";
import { SyncSchemaRegistry } from "./sync-schema.registry";
import { SyncAction, SyncOperation } from "./sync.types";

type TransactionWithBatch = Transaction & { parent?: Transaction; [SYNC_BATCH_ID]?: string };

/** Sequelize types attribute lists as `keyof` unions; the sync layer only ever deals with named columns. */
type AttributeNames = readonly (string | number | symbol)[];

type CaptureOptions = {
    transaction?: TransactionWithBatch | null;
    fields?: AttributeNames;
    updateOnDuplicate?: AttributeNames;
    conflictAttributes?: AttributeNames;
    conflictFields?: AttributeNames;
    individualHooks?: boolean;
    model?: ModelStatic<Model>;
    [SYNC_SUPPRESS]?: boolean;
};

/**
 * Turns every local write into outbox rows, inside the very transaction that performed the write.
 * Business data and its sync record therefore commit or roll back together - no dual write, no
 * network call holding a database lock, and nothing to remember at the call sites.
 *
 * Writes performed while replaying an inbound batch carry {@link SYNC_SUPPRESS} and are ignored,
 * which is what stops the two networks from echoing changes back and forth forever.
 */
@Injectable()
export class SyncCaptureService implements OnApplicationBootstrap {
    private readonly logger = new Logger(SyncCaptureService.name);

    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly registry: SyncSchemaRegistry,
        private readonly outbox: SyncOutboxRepository,
        private readonly config: SyncConfig
    ) { }

    onApplicationBootstrap(): void {
        if (!this.config.captureEnabled) return;

        this.sequelize.addHook("beforeBulkUpdate", (options: CaptureOptions) => this.expandToRows(options));
        this.sequelize.addHook("beforeBulkDestroy", (options: CaptureOptions) => this.expandToRows(options));

        this.sequelize.addHook("afterCreate", (instance: Model, options: CaptureOptions) =>
            this.record([this.describe(instance, options, SYNC_ACTIONS.UPSERT)], options));

        this.sequelize.addHook("afterUpsert", (result: [Model, boolean | null], options: CaptureOptions) =>
            this.record([this.describe(result[0], options, SYNC_ACTIONS.UPSERT, options.fields)], options));

        this.sequelize.addHook("afterUpdate", (instance: Model, options: CaptureOptions) =>
            this.record([this.describe(instance, options, SYNC_ACTIONS.UPDATE)], options));

        this.sequelize.addHook("afterDestroy", (instance: Model, options: CaptureOptions) =>
            this.record([this.describe(instance, options, SYNC_ACTIONS.DELETE)], options));

        this.sequelize.addHook("afterBulkCreate", (instances: Model[], options: CaptureOptions) =>
            this.record(
                options.individualHooks
                    ? [] // afterCreate already described every row
                    : instances.map((instance) => this.describe(instance, options, SYNC_ACTIONS.UPSERT, options.updateOnDuplicate)),
                options
            ));

        this.logger.log(`Change capture active on node "${this.config.nodeId}"`);
    }

    /**
     * A bulk update or delete only knows its `where` clause. Asking Sequelize for per row hooks is
     * what lets the payload name the exact rows by primary key instead of shipping a query.
     */
    private expandToRows(options: CaptureOptions): void {
        if (options[SYNC_SUPPRESS]) return;
        if (options.model && !this.registry.replicatedTable(options.model)) return;

        options.individualHooks = true;
    }

    private async record(operations: (SyncOperation | null)[], options: CaptureOptions): Promise<void> {
        const captured = operations.filter(isNonNullish);
        if (captured.length === 0) return;

        const batchId = this.batchIdFor(options);
        const now = new Date();

        await this.outbox.append(
            captured.map((operation) => ({
                batchId,
                sourceNode: this.config.nodeId,
                tableName: operation.table,
                action: operation.action,
                data: operation.data,
                updateFields: operation.update_fields ?? null,
                conflictFields: operation.conflict_fields ?? null,
                status: OUTBOX_STATUSES.PENDING,
                sequence: null,
                attempts: 0,
                nextAttemptAt: now,
                createdAt: now
            })),
            options.transaction ?? undefined
        );
    }

    private describe(
        instance: Model,
        options: CaptureOptions,
        action: SyncAction,
        restrictUpdateTo?: AttributeNames
    ): SyncOperation | null {
        if (options[SYNC_SUPPRESS]) return null;

        const model = instance.constructor as ModelStatic<Model>;
        const table = this.registry.replicatedTable(model);
        if (!table) return null;

        const primaryKeys = this.registry.primaryKeyAttributes(model);
        const attributes =
            action === SYNC_ACTIONS.DELETE ? primaryKeys : [...primaryKeys, ...writtenAttributes(instance, options)];
        const data = this.registry.toColumns(model, instance, attributes);

        for (const column of this.registry.toColumnNames(model, primaryKeys)) {
            if (data[column] === undefined || data[column] === null) {
                throw new InternalServerErrorException(
                    `Cannot replicate ${action} on "${table}": primary key column "${column}" is missing`
                );
            }
        }

        if (action !== SYNC_ACTIONS.UPSERT) return { table, action, data };

        const updateFields = restrictUpdateTo?.length
            ? this.registry.toColumnNames(model, names(restrictUpdateTo))
            : undefined;
        const conflictFields = options.conflictFields?.length
            ? names(options.conflictFields)
            : options.conflictAttributes?.length
                ? this.registry.toColumnNames(model, names(options.conflictAttributes))
                : undefined;

        return {
            table,
            action,
            data,
            ...(updateFields ? { update_fields: updateFields } : {}),
            ...(conflictFields ? { conflict_fields: conflictFields } : {})
        };
    }

    /** All writes of one transaction share a batch id, so the peer replays them as a single unit. */
    private batchIdFor(options: CaptureOptions): string {
        const transaction = options.transaction;
        if (!transaction) return randomUUID();

        const root = (transaction.parent ?? transaction) as TransactionWithBatch;
        root[SYNC_BATCH_ID] ??= randomUUID();

        return root[SYNC_BATCH_ID]!;
    }
}

const names = (attributes: AttributeNames): string[] => attributes.map(String);

const writtenAttributes = (instance: Model, options: CaptureOptions): string[] =>
    options.fields?.length ? names(options.fields) : Object.keys(instance.get({ plain: true }) ?? {});
