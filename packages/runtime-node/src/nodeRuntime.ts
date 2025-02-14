import {
  HttpErrorStatusCode,
  processRequest,
  RuntimeApp,
  RuntimeController,
  RuntimeInput,
  RuntimeResult,
  RuntimeRoute,
  statusCodeToDesc,
  Validator
} from '@apimda/runtime';
import { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import getRawBody from 'raw-body';
import { NodeRequestExtractor } from './nodeRequestExtractor';
import { RouteMatcher } from './routeMatcher';

const getBody = async (request: IncomingMessage, input: RuntimeInput) => {
  let bodyStream: Readable = request;
  const encoding = request.headers['content-encoding']?.toLowerCase();
  if (encoding === 'deflate') {
    bodyStream = request.pipe(zlib.createInflate());
  } else if (encoding === 'gzip') {
    bodyStream = request.pipe(zlib.createGunzip());
  }
  const opts: getRawBody.Options = {
    limit: '10mb', // apigw limit
    length: request.headers['content-length'],
    encoding: input.declaredTypeName === 'Buffer' ? null : true // utf-8
  };
  return await getRawBody(bodyStream, opts);
};

const sendErrorResponse = (response: ServerResponse, statusCode: HttpErrorStatusCode) => {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  response.write(statusCodeToDesc[statusCode]);
  response.end();
};

const sendResultResponse = (response: ServerResponse, result: RuntimeResult) => {
  const outgoingHeaders: Record<string, string | string[]> = {};
  for (const headerName in result.headers) {
    outgoingHeaders[headerName] = result.headers[headerName].toString();
  }
  if (!result.headers['Content-Type']) {
    outgoingHeaders['Content-Type'] = 'application/json';
  }

  const cookies: string[] = [];
  for (const cookieName in result.cookies) {
    cookies.push(`${cookieName}=${result.cookies[cookieName]}`);
  }
  if (cookies.length > 0) {
    outgoingHeaders['Set-Cookie'] = cookies;
  }
  response.writeHead(result.statusCode, outgoingHeaders);
  response.write(result.body);
  response.end();
};

class ControllerInstanceManager {
  private module: any;
  private instance: any;
  private initialized: boolean;

  constructor(public readonly runtime: RuntimeController) {
    this.initialized = runtime.initMethodName === undefined;
  }

  async getClass(): Promise<any> {
    const module = await this.loadModule();
    return module[this.runtime.className];
  }

  async getInstance(): Promise<any> {
    if (!this.instance) {
      const args = this.runtime.ctorEnvNames.map(e => process.env[e]!);
      const clazz = await this.getClass();
      this.instance = new clazz(args);
      if (!this.initialized) {
        await this.instance[this.runtime.initMethodName!].apply(this.instance);
        this.initialized = true;
      }
    }
    return this.instance;
  }

  async invokeAsync(methodName: string, args: any[]): Promise<any> {
    const instance = await this.getInstance();
    return await (instance[methodName] as Function).apply(instance, args);
  }

  async invokeStatic(methodName: string, args: any[]): Promise<any> {
    const clazz = await this.getClass();
    return (clazz[methodName] as Function)(...args);
  }

  private async loadModule(): Promise<any> {
    if (!this.module) {
      this.module = await import(this.runtime.moduleName);
    }
    return this.module;
  }
}

export const createRequestListener = (app: RuntimeApp): RequestListener => {
  const routeMatcher = new RouteMatcher();
  const routeMap = new Map<string, [ControllerInstanceManager, RuntimeRoute]>();
  for (const controller of app.controllers) {
    const controllerInstanceManager = new ControllerInstanceManager(controller);
    for (const route of controller.routes) {
      const routePath = `${route.method}/${route.path}`;
      routeMatcher.add(routePath);
      routeMap.set(routePath, [controllerInstanceManager, route]);
    }
  }
  const validator = new Validator(app.schemas);
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url) {
      sendErrorResponse(response, 404);
      return;
    }
    const url = new URL(request.url, 'http://${request.headers.host}');
    const routePath = `${request.method?.toLowerCase() ?? ''}/${url.pathname}`;
    const routeMatch = routeMatcher.match(routePath);
    if (!routeMatch) {
      sendErrorResponse(response, 404);
      return;
    }
    const [controllerInstanceManager, route] = routeMap.get(routeMatch.path)!;
    const bodyInput = route.inputs.find(i => i.location === 'body');
    const body = bodyInput ? await getBody(request, bodyInput) : undefined;
    const extractor = new NodeRequestExtractor(request, url, routeMatch.pathParameters, body);
    const instance = await controllerInstanceManager.getInstance();
    const result = await processRequest(extractor, route, instance, validator);
    sendResultResponse(response, result);
  };
};
