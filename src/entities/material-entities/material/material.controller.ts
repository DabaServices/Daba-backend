import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { MaterialService } from "./material.service";
import { PastedMaterialsDto } from "./material.types";
import { RequireScreenUnitRequesting } from "src/common/decorators/require-screen-unit-requesting.decorator";

@Controller('/materials')
export class MaterialController {
    constructor(private readonly service: MaterialService) { }

    @Get('excel')
    fetchExcelMaterials() {
        return this.service.fetchExcelMaterials();
    }

    @Get('twenty')
    fetchTwenty(@Query('filter') filter: string, @Req() request: Request) {
        return this.service.fetchTwenty(filter, Number(request.headers['unit']));
    }

    @Post('paste/:tab')
    pastedMaterials(@Body() pastedMaterials: PastedMaterialsDto,
        @Req() request: Request) {
        return this.service.fetchByIds(pastedMaterials, Number(request.headers['unit']));
    }
}
