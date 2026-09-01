import {
    Injectable,
    InternalServerErrorException,
    Logger,
    OnApplicationBootstrap,
    ServiceUnavailableException
} from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { randomUUID } from "node:crypto";
import { isNonNullish } from "remeda";
import { Model, ModelStatic, Transaction } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { SyncConfig } from "./sync.config";
import { SYNC_ACTIONS, SYNC_BATCH, SYNC_SUPPRESS, SYNC_TOKEN_HEADER } from "./sync.constants";
import { SyncSchemaRegistry } from "./sync-schema.registry";
import { SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncAction, SyncBatch, SyncOperation } from "./sync.types";

type PendingBatch = { id: string; operations: SyncOperation[] };

type TransactionWithBatch = Transaction & {
    parent?: Transaction;
    finished?: string;
    [SYNC_BATCH]?: PendingBatch;
};

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
 * Turns every local write into a batch and hands it to the peer before the local transaction is
 * allowed to commit. The peer accepting the batch is a precondition of the commit, so a change
 * either exists on both networks or on neither - there is nothing to remember at the call sites.
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
        private readonly sequences: SyncSequenceRepository,
        private readonly config: SyncConfig
    ) { }

    onApplicationBootstrap(): void {
        if (!this.config.enabled) return;

        this.sequelize.addHook("beforeBulkUpdate", (options: CaptureOptions) => this.expandToRows(options));
        this.sequelize.addHook("beforeBulkDestroy", (options: CaptureOptions) => this.expandToRows(options));

        this.sequelize.addHook("beforeCreate", (instance: Model, options: CaptureOptions) =>
            this.requireTransaction(modelOf(instance), options));

        this.sequelize.addHook("beforeUpdate", (instance: Model, options: CaptureOptions) =>
            this.requireTransaction(modelOf(instance), options));

        this.sequelize.addHook("beforeDestroy", (instance: Model, options: CaptureOptions) =>
            this.requireTransaction(modelOf(instance), options));

        this.sequelize.addHook("beforeBulkCreate", (instances: Model[], options: CaptureOptions) =>
            this.requireTransaction(instances[0] && modelOf(instances[0]), options));

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

        this.logger.log(`Change capture active on node "${this.config.nodeId}", peer ${this.config.batchesUrl}`);
    }

    /**
     * A bulk update or delete only knows its `where` clause. Asking Sequelize for per row hooks is
     * what lets the payload name the exact rows by primary key instead of shipping a query.
     */
    private expandToRows(options: CaptureOptions): void {
        if (options[SYNC_SUPPRESS]) return;
        if (options.model && !this.registry.replicatedTable(options.model)) return;

        this.requireTransaction(options.model, options);
        options.individualHooks = true;
    }

    /** Refuses the statement before it runs: outside a transaction there is no commit to hold back. */
    private requireTransaction(model: ModelStatic<Model> | undefined | false, options: CaptureOptions): void {
        if (options[SYNC_SUPPRESS] || options.transaction || !model) return;

        const table = this.registry.replicatedTable(model);
        if (!table) return;

        throw new InternalServerErrorException(
            `A write to "${table}" must run inside a transaction so the peer can accept it before the commit`
        );
    }

    private record(operations: (SyncOperation | null)[], options: CaptureOptions): void {
        const captured = operations.filter(isNonNullish);
        if (captured.length === 0) return;

        // Reached only by upsert, whose hook cannot name its model early enough to refuse the statement.
        if (!options.transaction) {
            throw new InternalServerErrorException(
                `A write to "${captured[0].table}" must run inside a transaction so the peer can accept it before the commit`
            );
        }

        this.pending(options.transaction).operations.push(...captured);
    }

    /** All writes of one transaction share a batch, so the peer applies them as a single unit. */
    private pending(transaction: TransactionWithBatch): PendingBatch {
        const root = (transaction.parent ?? transaction) as TransactionWithBatch;
        if (root[SYNC_BATCH]) return root[SYNC_BATCH];

        const batch: PendingBatch = { id: randomUUID(), operations: [] };
        root[SYNC_BATCH] = batch;

        const commit = root.commit.bind(root);
        const rollback = root.rollback.bind(root);

        // Sequelize has no "before commit" hook, so the commit itself becomes the send point.
        root.commit = async () => {
            try {
                await this.flush(batch, root);
            } catch (error) {
                // sequelize.transaction() does not roll back a failing commit; leaving it open leaks the connection.
                await rollback().catch(() => undefined);
                throw error;
            }

            return commit();
        };

        // Keeps the caller's own rollback harmless after the one above already ran.
        root.rollback = async () => (root.finished ? undefined : rollback());

        return batch;
    }

    private async flush(batch: PendingBatch, transaction: Transaction): Promise<void> {
        if (batch.operations.length === 0) return;

        const sequence = await this.sequences.nextOutbound(this.config.nodeId, batch.id, transaction);

        await this.send({
            sync_metadata: {
                batch_id: batch.id,
                source_node: this.config.nodeId,
                sequence,
                generated_at: new Date().toISOString()
            },
            operations: batch.operations
        });

        this.logger.log(`Peer accepted batch ${batch.id} (#${sequence}, ${batch.operations.length} operations)`);
    }

    private async send(batch: SyncBatch): Promise<void> {
        let response: Response;

        try {
            response = await fetch(this.config.batchesUrl, {
                method: "POST",
                headers: { "content-type": "application/json", [SYNC_TOKEN_HEADER]: this.config.token },
                body: JSON.stringify(batch),
                signal: AbortSignal.timeout(this.config.httpTimeoutMs)
            });
        } catch (error) {
            throw new ServiceUnavailableException(
                `Peer is unreachable, the change was not saved: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (!response.ok) {
            throw new ServiceUnavailableException(
                `Peer answered ${response.status}, the change was not saved: ${(await response.text()).slice(0, 500)}`
            );
        }
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
}

const names = (attributes: AttributeNames): string[] => attributes.map(String);

const modelOf = (instance: Model): ModelStatic<Model> => instance.constructor as ModelStatic<Model>;

const writtenAttributes = (instance: Model, options: CaptureOptions): string[] =>
    options.fields?.length ? names(options.fields) : Object.keys(instance.get({ plain: true }) ?? {});
