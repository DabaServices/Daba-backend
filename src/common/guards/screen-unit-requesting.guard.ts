import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { MESSAGE_TYPES, UNIT_STATUSES } from '../../constants';
import { UnitStatus } from '../../entities/unit-entities/units-statuses/units-statuses.model';

const SCREEN_UNIT_LOCKED_ERROR = 'יחידת המסך נעולה, אין אפשרות לבצע את הפעולה';

const getHeaderValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

@Injectable()
export class ScreenUnitRequestingGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { date?: string }>();
    const screenUnitId = Number(getHeaderValue(request.headers.unit));
    const screenDate =
      request.date ?? getHeaderValue(request.headers.screendate);

    const screenUnitStatus = await UnitStatus.findOne({
      attributes: ['unitStatusId'],
      where: {
        unitId: screenUnitId,
        date: screenDate,
      },
    });

    const statusId = screenUnitStatus?.unitStatusId ?? UNIT_STATUSES.REQUESTING;

    if (statusId === UNIT_STATUSES.WAITING_FOR_ALLOCATION) {
      throw new BadRequestException({
        message: SCREEN_UNIT_LOCKED_ERROR,
        type: MESSAGE_TYPES.FAILURE,
      });
    }

    return true;
  }
}
