import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { AppModule } from './appModule.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HeadersMiddeware } from './common/middlewares/headers';
import { SYNC_ROUTE } from './sync/sync.constants';

const UNAUTHENTICATED_PATHS = ['/api-docs', '/server-time', `/${SYNC_ROUTE}`];

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: '*',
    methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  });

  app.use((req, res, next) => {
    if (UNAUTHENTICATED_PATHS.some((path) => req.path.startsWith(path))) return next();
    new HeadersMiddeware().use(req, res, next);
  });
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb' }));

  const config = new DocumentBuilder()
    .setTitle('API')
    .setDescription('Backend API documentation')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'screendate' }, 'screendate')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'user' }, 'user')
    .addSecurityRequirements('screendate')
    .addSecurityRequirements('user')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
