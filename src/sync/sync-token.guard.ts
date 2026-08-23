import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { SyncConfig } from "./sync.config";
import { SYNC_TOKEN_HEADER } from "./sync.constants";

/**
 * The sync endpoints are machine to machine and carry no user context, so they are authenticated
 * with the shared secret every node is configured with instead of the screen headers.
 */
@Injectable()
export class SyncTokenGuard implements CanActivate {
    constructor(private readonly config: SyncConfig) { }

    canActivate(context: ExecutionContext): boolean {
        const header = context.switchToHttp().getRequest<Request>().headers[SYNC_TOKEN_HEADER];
        const presented = Array.isArray(header) ? header[0] : header;

        if (!this.config.token || !presented || !matches(presented, this.config.token)) {
            throw new UnauthorizedException("Invalid synchronization token");
        }

        return true;
    }
}

/** Compared as digests so neither the value nor its length leaks through timing. */
const matches = (presented: string, expected: string): boolean =>
    timingSafeEqual(digest(presented), digest(expected));

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
