"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkHealth = void 0;
const asyncHandler_1 = require("../utils/asyncHandler");
const responseHandler_1 = require("../utils/responseHandler");
exports.checkHealth = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    (0, responseHandler_1.successResponse)(res, 200, 'Luxy Galleria API is up and running!', {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});
//# sourceMappingURL=healthController.js.map