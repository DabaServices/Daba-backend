import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { AppModule } from './appModule.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { ApplicationAccessMiddleware } from './common/authorization/application-access.middleware';
import { HeadersMiddeware } from './common/middlewares/headers';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: '*',
    methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  });

  app.use((req, res, next) => {
    const publicPrefixes = ['/api-docs', '/server-time', '/health'];
    if (publicPrefixes.some(prefix => req.path.startsWith(prefix))) return next();
    new HeadersMiddeware().use(req, res, next);
  });
  app.use((req, res, next) => {
    void new ApplicationAccessMiddleware().use(req, res, next);
  });
  app.useGlobalInterceptors(app.get(ResponseInterceptor));
  app.useGlobalFilters(app.get(HttpExceptionFilter));

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

  await app.listen(3000);
}

bootstrap();
