import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Length, Min, ValidateNested } from "class-validator";
import { SYNC_ACTIONS } from "./sync.constants";
import type { SyncAction } from "./sync.types";

export class SyncMetadataDto {
    @IsUUID()
    batch_id: string;

    @IsString()
    @Length(1, 64)
    source_node: string;

    @IsInt()
    @Min(1)
    sequence: number;

    @IsISO8601()
    generated_at: string;
}

export class SyncOperationDto {
    @IsString()
    @Length(1, 128)
    table: string;

    @IsIn(Object.values(SYNC_ACTIONS))
    action: SyncAction;

    @IsObject()
    data: Record<string, unknown>;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    update_fields?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    conflict_fields?: string[];
}

export class SyncBatchDto {
    @ValidateNested()
    @Type(() => SyncMetadataDto)
    sync_metadata: SyncMetadataDto;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => SyncOperationDto)
    operations: SyncOperationDto[];
}
