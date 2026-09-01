import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Both networks run this exact code. Only these variables differ.
 *
 * SYNC_ENABLED         master switch. When false the module is inert.
 * SYNC_NODE_ID         stable identity of this node, e.g. "network_a". Must never be reused.
 * SYNC_PEER_URL        base URL of the other network, e.g. "https://network-b.internal:3000".
 * SYNC_TOKEN           shared secret presented on every request. Required whenever sync is enabled.
 * SYNC_TABLES          optional comma separated allowlist of physical tables. Empty = every mapped table.
 * SYNC_HTTP_TIMEOUT_MS how long a local transaction may wait for the peer (default 10000).
 */
@Injectable()
export class SyncConfig {
    readonly enabled: boolean;
    readonly nodeId: string;
    readonly peerUrl: string;
    readonly token: string;
    readonly tables: ReadonlySet<string>;
    readonly httpTimeoutMs: number;

    constructor(configService: ConfigService) {
        this.enabled = readBoolean(configService, "SYNC_ENABLED", false);
        this.nodeId = configService.get<string>("SYNC_NODE_ID", "").trim();
        this.peerUrl = configService.get<string>("SYNC_PEER_URL", "").trim().replace(/\/+$/, "");
        this.token = configService.get<string>("SYNC_TOKEN", "");
        this.tables = readTables(configService);
        this.httpTimeoutMs = readNumber(configService, "SYNC_HTTP_TIMEOUT_MS", 10_000);

        this.assertUsable();
    }

    get batchesUrl(): string {
        return `${this.peerUrl}/sync/batches`;
    }

    private assertUsable(): void {
        if (!this.enabled) return;

        const missing = [
            !this.nodeId && "SYNC_NODE_ID",
            !this.token && "SYNC_TOKEN",
            !this.peerUrl && "SYNC_PEER_URL"
        ].filter(Boolean);

        if (missing.length > 0) {
            throw new Error(`Synchronization is enabled but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing`);
        }
    }
}

const readBoolean = (configService: ConfigService, key: string, fallback: boolean): boolean => {
    const raw = configService.get<string>(key);
    return raw === undefined ? fallback : ["1", "true", "yes"].includes(raw.trim().toLowerCase());
};

const readNumber = (configService: ConfigService, key: string, fallback: number): number => {
    const parsed = Number(configService.get<string>(key));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readTables = (configService: ConfigService): ReadonlySet<string> =>
    new Set(
        configService
            .get<string>("SYNC_TABLES", "")
            .split(",")
            .map((table) => table.trim())
            .filter((table) => table.length > 0)
    );
