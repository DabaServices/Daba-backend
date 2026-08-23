import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SYNC_INBOUND_MODES } from "./sync.constants";
import { SyncInboundMode } from "./sync.types";

/**
 * Every participant - the network A backend, the network B backend and the standalone bridge
 * between them - runs this exact code. Only these variables differ.
 *
 * SYNC_ENABLED              master switch. When false the module is inert.
 * SYNC_NODE_ID              stable identity of this node, e.g. "network_a". Must never be reused.
 * SYNC_INBOUND_MODE         APPLY   -> write inbound batches into the business tables (a backend node)
 *                           FORWARD -> queue inbound batches and relay them onwards (the bridge server)
 * SYNC_RELAY_ENABLED        run the outbound relay loop here. Exactly one instance per node.
 * SYNC_PEER_URL             base URL of the next hop, e.g. "https://sync-bridge.internal:3000"
 * SYNC_TOKEN                shared secret presented on every hop. Required whenever sync is enabled.
 * SYNC_TABLES               optional comma separated allowlist of physical tables. Empty = every mapped table.
 * SYNC_POLL_INTERVAL_MS     relay poll period (default 1000)
 * SYNC_HTTP_TIMEOUT_MS      timeout of a single delivery attempt (default 10000)
 * SYNC_RETRY_BASE_MS        first retry delay, doubled on every failure (default 1000)
 * SYNC_RETRY_MAX_MS         retry delay ceiling (default 60000)
 * SYNC_ALERT_AFTER_ATTEMPTS log an error once the head batch has failed this many times (default 10)
 * SYNC_RETENTION_DAYS       how long delivered rows are kept for audit (default 14)
 */
@Injectable()
export class SyncConfig {
    readonly enabled: boolean;
    readonly nodeId: string;
    readonly inboundMode: SyncInboundMode;
    readonly relayEnabled: boolean;
    readonly peerUrl: string;
    readonly token: string;
    readonly tables: ReadonlySet<string>;
    readonly pollIntervalMs: number;
    readonly httpTimeoutMs: number;
    readonly retryBaseMs: number;
    readonly retryMaxMs: number;
    readonly alertAfterAttempts: number;
    readonly retentionDays: number;

    constructor(configService: ConfigService) {
        this.enabled = readBoolean(configService, "SYNC_ENABLED", false);
        this.nodeId = configService.get<string>("SYNC_NODE_ID", "").trim();
        this.inboundMode = readInboundMode(configService);
        this.relayEnabled = this.enabled && readBoolean(configService, "SYNC_RELAY_ENABLED", false);
        this.peerUrl = configService.get<string>("SYNC_PEER_URL", "").trim().replace(/\/+$/, "");
        this.token = configService.get<string>("SYNC_TOKEN", "");
        this.tables = readTables(configService);
        this.pollIntervalMs = readNumber(configService, "SYNC_POLL_INTERVAL_MS", 1_000);
        this.httpTimeoutMs = readNumber(configService, "SYNC_HTTP_TIMEOUT_MS", 10_000);
        this.retryBaseMs = readNumber(configService, "SYNC_RETRY_BASE_MS", 1_000);
        this.retryMaxMs = readNumber(configService, "SYNC_RETRY_MAX_MS", 60_000);
        this.alertAfterAttempts = readNumber(configService, "SYNC_ALERT_AFTER_ATTEMPTS", 10);
        this.retentionDays = readNumber(configService, "SYNC_RETENTION_DAYS", 14);

        this.assertUsable();
    }

    /** Only a node that owns the business data captures local changes; the bridge just relays. */
    get captureEnabled(): boolean {
        return this.enabled && this.inboundMode === SYNC_INBOUND_MODES.APPLY;
    }

    get batchesUrl(): string {
        return `${this.peerUrl}/sync/batches`;
    }

    private assertUsable(): void {
        if (!this.enabled) return;

        const missing = [
            !this.nodeId && "SYNC_NODE_ID",
            !this.token && "SYNC_TOKEN",
            this.relayEnabled && !this.peerUrl && "SYNC_PEER_URL"
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

const readInboundMode = (configService: ConfigService): SyncInboundMode => {
    const raw = configService.get<string>("SYNC_INBOUND_MODE", SYNC_INBOUND_MODES.APPLY).trim().toUpperCase();
    if (raw !== SYNC_INBOUND_MODES.APPLY && raw !== SYNC_INBOUND_MODES.FORWARD) {
        throw new Error(`SYNC_INBOUND_MODE must be ${SYNC_INBOUND_MODES.APPLY} or ${SYNC_INBOUND_MODES.FORWARD}`);
    }
    return raw;
};

const readTables = (configService: ConfigService): ReadonlySet<string> =>
    new Set(
        configService
            .get<string>("SYNC_TABLES", "")
            .split(",")
            .map((table) => table.trim())
            .filter((table) => table.length > 0)
    );
