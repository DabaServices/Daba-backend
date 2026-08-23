import { BadRequestException, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { unique } from "remeda";
import { Model, ModelStatic } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { SyncConfig } from "./sync.config";
import { SYNC_INTERNAL_TABLES } from "./sync.constants";

type AttributeDefinition = { field?: string; primaryKey?: boolean };

type TableSchema = {
    table: string;
    model: ModelStatic<Model>;
    attributes: Record<string, AttributeDefinition>;
    attributeByColumn: Record<string, string>;
    primaryKeyAttributes: string[];
};

/**
 * The single source of truth for what may cross the network and how a flat `column -> value`
 * dictionary maps onto a Sequelize model. Keeping the translation here is what lets the payload
 * stay generic while every inbound write remains restricted to known tables and known columns.
 */
@Injectable()
export class SyncSchemaRegistry implements OnApplicationBootstrap {
    private readonly logger = new Logger(SyncSchemaRegistry.name);
    private readonly byTable = new Map<string, TableSchema>();
    private readonly byModel = new Map<ModelStatic<Model>, TableSchema>();

    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly config: SyncConfig
    ) { }

    /** Runs after every entity module has registered its models with the connection. */
    onApplicationBootstrap(): void {
        for (const model of Object.values(this.sequelize.models) as ModelStatic<Model>[]) {
            const schema = describe(model);
            if (!this.isReplicated(schema)) continue;

            this.byTable.set(schema.table, schema);
            this.byModel.set(model, schema);
        }

        this.logger.log(`${this.byTable.size} tables are replicated`);
    }

    /** The physical table name when the model participates in synchronization, otherwise null. */
    replicatedTable(model: ModelStatic<Model>): string | null {
        return this.byModel.get(model)?.table ?? null;
    }

    schemaOf(table: string): TableSchema {
        const schema = this.byTable.get(table);
        if (!schema) throw new BadRequestException(`Table "${table}" is not replicated`);

        return schema;
    }

    modelOf(table: string): ModelStatic<Model> {
        return this.schemaOf(table).model;
    }

    primaryKeyAttributes(model: ModelStatic<Model>): string[] {
        return this.byModel.get(model)?.primaryKeyAttributes ?? [];
    }

    /** Reads the given attributes off an instance and returns them keyed by database column. */
    toColumns(model: ModelStatic<Model>, instance: Model, attributes: string[]): Record<string, unknown> {
        const schema = this.byModel.get(model);
        if (!schema) return {};

        const data: Record<string, unknown> = {};
        for (const attribute of unique(attributes)) {
            const definition = schema.attributes[attribute];
            if (!definition) continue;

            const value = instance.getDataValue(attribute as never);
            if (value === undefined) continue;

            data[definition.field ?? attribute] = value;
        }

        return data;
    }

    /** Inverse of {@link toColumns}. Unknown columns are rejected rather than silently dropped. */
    toAttributes(table: string, data: Record<string, unknown>): Record<string, unknown> {
        const schema = this.schemaOf(table);

        return Object.fromEntries(
            Object.entries(data).map(([column, value]) => [attributeOf(schema, column), value])
        );
    }

    toAttributeNames(table: string, columns: string[]): string[] {
        const schema = this.schemaOf(table);

        return columns.map((column) => attributeOf(schema, column));
    }

    toColumnNames(model: ModelStatic<Model>, attributes: string[]): string[] {
        const schema = this.byModel.get(model);
        if (!schema) return [];

        return unique(attributes)
            .filter((attribute) => schema.attributes[attribute])
            .map((attribute) => schema.attributes[attribute].field ?? attribute);
    }

    /** The `where` clause identifying a single row. A missing key means the payload cannot be trusted. */
    primaryKeyValues(table: string, values: Record<string, unknown>): Record<string, unknown> {
        const schema = this.schemaOf(table);

        return Object.fromEntries(
            schema.primaryKeyAttributes.map((attribute) => {
                if (values[attribute] === undefined || values[attribute] === null) {
                    throw new BadRequestException(`Table "${table}" requires primary key "${attribute}"`);
                }

                return [attribute, values[attribute]];
            })
        );
    }

    private isReplicated(schema: TableSchema): boolean {
        if (SYNC_INTERNAL_TABLES.includes(schema.table)) return false;
        if (schema.primaryKeyAttributes.length === 0) return false;

        return this.config.tables.size === 0 || this.config.tables.has(schema.table);
    }
}

const describe = (model: ModelStatic<Model>): TableSchema => {
    const attributes = model.getAttributes() as unknown as Record<string, AttributeDefinition>;
    const target = model.getTableName() as unknown as string | { tableName: string };
    const columnOf = (attribute: string) => attributes[attribute].field ?? attribute;

    return {
        table: typeof target === "string" ? target : target.tableName,
        model,
        attributes,
        attributeByColumn: Object.fromEntries(Object.keys(attributes).map((attribute) => [columnOf(attribute), attribute])),
        primaryKeyAttributes: Object.keys(attributes).filter((attribute) => attributes[attribute].primaryKey)
    };
};

const attributeOf = (schema: TableSchema, column: string): string => {
    const attribute = schema.attributeByColumn[column];
    if (!attribute) throw new BadRequestException(`Column "${column}" does not exist on table "${schema.table}"`);

    return attribute;
};
