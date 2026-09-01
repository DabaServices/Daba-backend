import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { SYNC_BATCHES_PATH, SYNC_ROUTE } from "./sync.constants";
import { SyncBatchDto } from "./sync.dto";
import { SyncInboundService } from "./sync-inbound.service";
import { SyncTokenGuard } from "./sync-token.guard";

@Controller(SYNC_ROUTE)
@UseGuards(SyncTokenGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SyncController {
    constructor(private readonly service: SyncInboundService) { }

    /**
     * The status is the whole answer: 200 lets the sender commit, anything else makes it roll back.
     * 409 means the batch is out of order.
     */
    @Post(SYNC_BATCHES_PATH)
    @HttpCode(HttpStatus.OK)
    receiveBatch(@Body() batch: SyncBatchDto): Promise<void> {
        return this.service.receive(batch);
    }
}
