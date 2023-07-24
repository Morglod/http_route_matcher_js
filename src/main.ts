import net from "net";
import fs from "fs";
import groupBy from "lodash/groupBy";
import uniq from "lodash/uniq";

import express from "express";
import Fastify from "fastify";
import http from "http";

let counter = 0;

function stringToInt32(str: string) {
    return (
        ((str.charCodeAt(0) & 0xff) << 24) |
        ((str.charCodeAt(1) & 0xff) << 16) |
        ((str.charCodeAt(2) & 0xff) << 8) |
        (str.charCodeAt(3) & 0xff)
    );
}

const METHODS = {
    GET: {
        maskI32: stringToInt32("GET "),
        offset: 4,
    },
    POST: {
        maskI32: stringToInt32("POST"),
        offset: 5,
    },
    PUT: {
        maskI32: stringToInt32("PUT "),
        offset: 4,
    },
    DELETE: {
        maskI32: stringToInt32("DELE"),
        offset: 7,
    },
    HEAD: {
        maskI32: stringToInt32("HEAD"),
        offset: 5,
    },
    OPTIONS: {
        maskI32: stringToInt32("OPTI"),
        offset: 8,
    },
    PATCH: {
        maskI32: stringToInt32("PATC"),
        offset: 6,
    },
    CONNECT: {
        maskI32: stringToInt32("CONN"),
        offset: 8,
    },
    TRACE: {
        maskI32: stringToInt32("TRAC"),
        offset: 6,
    },
};

type Route = {
    method: keyof typeof METHODS;
    path: string[]; // [ 'api', ':version', '...' ]
    then: (parsedParams: Record<string, string>, callArg: any) => void;
};

type RoutePrepared = {
    method: keyof typeof METHODS;
    path: string[]; // [ 'api', ':version', '...' ]
    then: (parsedParams: Record<string, string>, callArg: any) => void;
    routeIndex: number;
};

function _sliceRoutes(routes: RoutePrepared[]) {
    return routes
        .map((x) => ({
            ...x,
            path: x.path.slice(1),
        }))
        .filter((x) => x.path.length !== 0);
}

function emitMatchSubroute_parts(
    code: string,
    routes: RoutePrepared[],
    routePartIndex: number
) {
    if (routes.length === 0) {
        throw "this should never happen";
    }

    const mroutes0_ = groupBy(routes, (x) => x.path[0]);
    const mroutes0 = Object.entries(mroutes0_).sort((a, b) => {
        if (a[0][0] === ":") return 1;
        return -1;
    });
    for (const [mr0subpath, mr0routes] of mroutes0) {
        const sliced = _sliceRoutes(mr0routes);
        if (mr0subpath[0] === ":") {
            const paramName = mr0subpath.substring(1);
            code += `parsedParams["${paramName}"] = routeParts[${routePartIndex}];\n`;
            if (sliced.length === 0) {
                if (mr0routes.length !== 1) {
                    throw "multiple routes with same path";
                }
                code += `routes[${mr0routes[0].routeIndex}].then(parsedParams, callArg);\nreturn;\n`;
            } else {
                code = emitMatchSubroute_parts(
                    code,
                    sliced,
                    routePartIndex + 1
                );
            }
        } else {
            code += `if (routeParts[${routePartIndex}] === "${mr0subpath}") {\n`;
            if (sliced.length === 0) {
                if (mr0routes.length !== 1) {
                    throw "multiple routes with same path";
                }
                code += `routes[${mr0routes[0].routeIndex}].then(parsedParams, callArg);\nreturn;\n`;
            } else {
                code = emitMatchSubroute_parts(
                    code,
                    sliced,
                    routePartIndex + 1
                );
            }
            code += `}\n`;
        }
    }
    return code;
}

function emitMatchSubroute_plain(
    code: string,
    routes: RoutePrepared[],
    reqUrlSubIndex: number
) {
    if (routes.length === 0) {
        throw "this should never happen";
    }

    const mroutes0_ = groupBy(routes, (x) => x.path[0]);
    const mroutes0 = Object.entries(mroutes0_).sort((a, b) => {
        if (a[0][0] === ":") return 1;
        return -1;
    });
    for (const [mr0subpath, mr0routes] of mroutes0) {
        const sliced = _sliceRoutes(mr0routes);
        if (mr0subpath[0] === ":") {
            const paramName = mr0subpath.substring(1);
            code += `var routeParts = reqUrl.substr(${
                reqUrlSubIndex + 1
            }).split('/');\n`;
            code += `parsedParams["${paramName}"] = routeParts[0];\n`;
            if (sliced.length === 0) {
                if (mr0routes.length !== 1) {
                    throw "multiple routes with same path";
                }
                code += `routes[${mr0routes[0].routeIndex}].then(parsedParams, callArg);\nreturn;\n`;
            } else {
                code = emitMatchSubroute_parts(code, sliced, 1);
            }
        } else {
            const testStr = "/" + mr0subpath;
            code += `if (reqUrl.indexOf('${testStr}', ${reqUrlSubIndex}) === ${reqUrlSubIndex}) {\n`;
            if (sliced.length === 0) {
                if (mr0routes.length !== 1) {
                    throw "multiple routes with same path";
                }
                code += `routes[${mr0routes[0].routeIndex}].then(parsedParams, callArg);\nreturn;\n`;
            } else {
                code = emitMatchSubroute_plain(
                    code,
                    sliced,
                    reqUrlSubIndex + testStr.length
                );
            }
            code += `}\n`;
        }
    }
    return code;
}

type RoutesMatcherFn = (
    method: string,
    routes: Route[],
    reqUrl: string,
    queryParams: any,
    callArg: any
) => void;

function buildRoutesMatcher(routes_: Route[]) {
    const routes: RoutePrepared[] = routes_.map((x, i) => ({
        ...x,
        routeIndex: i,
    }));

    let code = `(function(method, routes, reqUrl, queryParams, callArg) {\n`;

    const allParams = uniq(
        routes
            .flatMap((x) =>
                x.path.flatMap((y) => (y[0] === ":" ? y : undefined))
            )
            .filter(Boolean) as string[]
    );
    code += `const parsedParams = {\n`;
    for (const p of allParams) {
        code += `"${p.substring(1)}": undefined,\n`;
    }
    code += `};\n`;

    const routesByMethods = groupBy(routes, "method");
    for (const m in routesByMethods) {
        code += `/* ${m} */\n`;
        code += `if (method === "${m}") {\n`;
        code = emitMatchSubroute_plain(code, routesByMethods[m], 0);
        code += `}\n`;
    }

    code += `})`;

    return code;
}

function testMacherEval() {
    const testRoutes: Route[] = [
        {
            method: "GET",
            path: ["api", "0.1", "cars", "list"],
            then: (p: any, res: http.ServerResponse<http.IncomingMessage>) =>
                console.log("Hello world2!"),
        },
        {
            method: "GET",
            path: ["api", "0.1", "cars", ":id"],
            then: (p: any, res: http.ServerResponse<http.IncomingMessage>) =>
                console.log("Hello world1!"),
        },
        {
            method: "POST",
            path: ["api", "0.1", "cars"],
            then: (p: any, res: http.ServerResponse<http.IncomingMessage>) =>
                console.log("Hello world0!"),
        },
    ];

    const testMatcherCode = buildRoutesMatcher(testRoutes);
    // console.log(testMatcherCode);

    const testMatcherFn = eval(testMatcherCode) as RoutesMatcherFn;
    console.log(testMatcherFn("GET", testRoutes, "/api/0.1/cars/125", {}, {}));
}

// testMacherEval();

// const routesHandler = buildTestRoutesHandler();

// const server = net.createServer({}, (sock) => {
//     const id = counter++;

//     sock.addListener("data", (data) => {
//         const dv = new DataView(data.buffer);
//         const method_i32 = dv.getInt32(0);

//         if (METHODS.GET.maskI32 === method_i32) {
//             const httpReqStr = data.subarray(METHODS.GET.offset).toString();
//             const httpPath = httpReqStr.substring(0, httpReqStr.indexOf(" "));

//             console.log("match", "GET", httpPath);

//             routesHandler(
//                 { method: "GET", url: httpPath },
//                 {
//                     send: (outStr: string) => {
//                         sock.write(outStr);
//                         sock.write("\n\n");
//                         sock.end();
//                     },
//                 }
//             );
//         }
//     });
// });

// server.listen(9080);

function routesBuilder() {
    type Ebal = (
        req: http.IncomingMessage,
        res: http.ServerResponse<http.IncomingMessage>
    ) => void;
    const routes: Route[] = [];
    const b = {
        get(path: string, then: Ebal) {
            routes.push({
                method: "GET",
                path: path.substring(1).split("/"),
                then: (x: any, { req, res }: any) => then(req, res),
            });
            return b;
        },
        post(path: string, then: Ebal) {
            routes.push({
                method: "POST",
                path: path.substring(1).split("/"),
                then: (x: any, { req, res }: any) => then(req, res),
            });
            return b;
        },
        build() {
            const matcher = eval(buildRoutesMatcher(routes));
            return (req: http.IncomingMessage, res: http.ServerResponse) => {
                matcher(req.method!, routes, req.url!, {}, { req, res });
            };
        },
    };
    return b;
}

function buildTestRoutesHandler() {
    return routesBuilder()
        .get("/api/0.1/cars/:id", (req, res: any) => {
            res.send("Hello World2!");
        })
        .get("/api/0.1/cars/list", (req, res: any) => {
            res.send("Hello World1!");
        })
        .post("/api/0.1/cars", (req, res: any) => {
            res.send("Hello World0!");
        })
        .build() as any;
}

function testHttpServer() {
    const server = http.createServer(
        routesBuilder()
            .get("/api/0.1/cars/:id", (req, res) => {
                res.end("Hello World2!");
            })
            .get("/api/0.1/cars/list", (req, res) => {
                res.end("Hello World1!");
            })
            .post("/api/0.1/cars", (req, res) => {
                res.end("Hello World0!");
            })
            .build()
    );

    server.listen(9080, () => {
        console.log(`http://localhost:${9080}/`);
    });
}

function testExpressServer(fast: boolean) {
    const app = express();
    if (fast) {
        app.all(
            "*",
            routesBuilder()
                .get("/api/0.1/cars/:id", (req, res) => {
                    res.end("Hello World2!");
                })
                .get("/api/0.1/cars/list", (req, res) => {
                    res.end("Hello World1!");
                })
                .post("/api/0.1/cars", (req, res) => {
                    res.end("Hello World0!");
                })
                .build()
        );
    } else {
        app.get("/api/0.1/cars/:id", (req, res) => {
            res.end("Hello World2!");
        });

        app.get("/api/0.1/cars/list", (req, res) => {
            res.end("Hello World1!");
        });

        app.post("/api/0.1/cars", (req, res) => {
            res.end("Hello World0!");
        });
    }
    app.listen(9080, () => {
        console.log(`http://localhost:${9080}/`);
    });
}

function testFastify() {
    const app = Fastify();
    app.all("*", buildTestRoutesHandler());

    app.listen(9080, () => {
        console.log(`http://localhost:${9080}/`);
    });
}
