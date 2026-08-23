import { Module } from "@nestjs/common";
import { SequelizeModule } from "@nestjs/sequelize";
import { SyncOutbox } from "./models/sync-outbox.model";
import { SyncSequence } from "./models/sync-sequence.model";
import { SyncCaptureService } from "./sync-capture.service";
import { SyncConfig } from "./sync.config";
import { SyncController } from "./sync.controller";
import { SyncExecutorService } from "./sync-executor.service";
import { SyncInboundService } from "./sync-inbound.service";
import { SyncOutboxRepository } from "./sync-outbox.repository";
import { SyncRelayService } from "./sync-relay.service";
import { SyncSchemaRegistry } from "./sync-schema.registry";
import { SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncTokenGuard } from "./sync-token.guard";

@Module({
    imports: [SequelizeModule.forFeature([SyncOutbox, SyncSequence])],
    providers: [
        SyncConfig,
        SyncSchemaRegistry,
        SyncSequenceRepository,
        SyncOutboxRepository,
        SyncCaptureService,
        SyncExecutorService,
        SyncInboundService,
        SyncRelayService,
        SyncTokenGuard
    ],
    controllers: [SyncController]
})
export class SyncModule { }
