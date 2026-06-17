import { Controller, Get } from "@nestjs/common";

type HealthResponse = {
    status: "ok";
    service: string;
    timestamp: string;
    uptimeSeconds: number;
};

@Controller()
export class HealthController {
    @Get("health")
    check(): HealthResponse {
        return {
            status: "ok",
            service: "daba",
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
        };
    }
}
