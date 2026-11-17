import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Express 5 forwards rejected promises, but being explicit keeps behaviour stable. */
export function asyncHandler(handler: AsyncHandler): RequestHandler {
    return (req, res, next) => {
        handler(req, res, next).catch(next);
    };
}
