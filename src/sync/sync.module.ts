import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { SyncSequence } from "./models/sync-sequence.model";
import { SyncCaptureService } from "./sync-capture.service";
import { SyncConfig } from "./sync.config";
import { SyncController } from "./sync.controller";
import { SyncExecutorService } from "./sync-executor.service";
import { SyncInboundService } from "./sync-inbound.service";
import { SyncSchemaRegistry } from "./sync-schema.registry";
import { SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncTokenGuard } from "./sync-token.guard";

@Module({
    imports: [SequelizeModule.forFeature([SyncSequence])],
    providers: [
        SyncConfig,
        SyncSchemaRegistry,
        SyncSequenceRepository,
        SyncCaptureService,
        SyncExecutorService,
        SyncInboundService,
        SyncTokenGuard
    ],
    controllers: [SyncController]
})
export class SyncModule { }
