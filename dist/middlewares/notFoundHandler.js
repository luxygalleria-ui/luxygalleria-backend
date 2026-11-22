"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = void 0;
const responseHandler_1 = require("../utils/responseHandler");
// The requested URL is not echoed back: its query string can carry tokens or payment parameters
const notFoundHandler = (req, res, next) => {
    (0, responseHandler_1.errorResponse)(res, 404, 'Route not found');
};
exports.notFoundHandler = notFoundHandler;
//# sourceMappingURL=notFoundHandler.js.map