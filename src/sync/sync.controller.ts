import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { SYNC_BATCHES_PATH, SYNC_ROUTE } from "./sync.constants";
import { SyncBatchDto } from "./sync.dto";
import { SyncInboundService } from "./sync-inbound.service";
import { SyncTokenGuard } from "./sync-token.guard";
import { SyncReceipt, SyncStatus } from "./sync.types";

@Controller(SYNC_ROUTE)
@UseGuards(SyncTokenGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SyncController {
    constructor(private readonly service: SyncInboundService) { }

    /**
     * 200 - the batch was applied, forwarded, or already known.
     * 409 - a predecessor is still missing; the sender retries until the gap closes.
     */
    @Post(SYNC_BATCHES_PATH)
    @HttpCode(HttpStatus.OK)
    receiveBatch(@Body() batch: SyncBatchDto): Promise<SyncReceipt> {
        return this.service.receive(batch);
    }

    @Get("status")
    status(): Promise<SyncStatus> {
        return this.service.status();
    }
}
