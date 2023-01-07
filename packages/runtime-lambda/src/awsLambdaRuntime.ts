import {
  ControllerInstanceManager,
  HttpError,
  InputExtractor,
  processRequest,
  RuntimeApp,
  RuntimeInput,
  RuntimeResult,
  RuntimeRoute,
  Validator
} from '@apimda/runtime';
import type { APIGatewayProxyEventV2 as Event, APIGatewayProxyStructuredResultV2 as Result } from 'aws-lambda';

const toLambdaCookies = (cookies: Record<string, string | number | boolean>): string[] => {
  const result: string[] = [];
  for (const cookieName in cookies) {
    result.push(`${cookieName}=${cookies[cookieName]}`);
  }
  return result;
};

const toLambdaResult = (result: RuntimeResult): Result => {
  return {
    statusCode: result.statusCode,
    headers: result.headers,
    cookies: toLambdaCookies(result.cookies),
    body: result.isBinary ? (result.body as Buffer).toString('base64') : (result.body as string),
    isBase64Encoded: result.isBinary
  };
};

export class LambdaExtractor implements InputExtractor<Event> {
  constructor(private event: Event) {}

  extract(input: RuntimeInput): string | Buffer | Event | undefined {
    switch (input.location) {
      case 'request':
        return this.event;
      case 'query':
        return (this.event.queryStringParameters || {})[input.name];
      case 'path':
        return (this.event.pathParameters || {})[input.name];
      case 'header':
        return (this.event.headers || {})[input.name.toLowerCase()];
      case 'cookie':
        if (this.event.cookies) {
          for (const cookie of this.event.cookies) {
            const eqIdx = cookie.indexOf('=');
            if (eqIdx > 0) {
              const name = cookie.substring(0, eqIdx);
              const value = cookie.substring(eqIdx + 1);
              if (input.name === name) {
                return value;
              }
            }
          }
        }
        return undefined;
      case 'body':
        if (!this.event.body) {
          return undefined;
        }
        if (input.declaredTypeName === 'string') {
          return this.event.body;
        }
        if (input.declaredTypeName === 'Buffer') {
          if (!this.event.isBase64Encoded) {
            throw new HttpError(400, 'Expected binary input');
          }
          return Buffer.from(this.event.body, 'base64');
        }
        return JSON.parse(this.event.body);
      default:
        throw new Error(`Unsupported param type: ${input.location}`);
    }
  }
}

interface RouteInfo {
  controllerManager: ControllerInstanceManager;
  route: RuntimeRoute;
}

/**
 * Create a handler for all routes on the specified app.
 * @param app runtime app metadata
 */
export function createAwsLambdaHandler(app: RuntimeApp) {
  const routesByPath: Record<string, RouteInfo> = {};
  for (const controller of app.controllers) {
    const controllerManager = new ControllerInstanceManager(controller);
    for (const route of controller.routes) {
      routesByPath[`${route.method.toUpperCase()} ${route.path}`] = { controllerManager, route };
    }
  }
  const validator = new Validator(app.schemas);
  return async (event: Event) => {
    const routeInfo = routesByPath[event.routeKey];
    const extractor = new LambdaExtractor(event);
    const result = await processRequest(event, extractor, routeInfo.route, routeInfo.controllerManager, validator);
    return toLambdaResult(result);
  };
}
