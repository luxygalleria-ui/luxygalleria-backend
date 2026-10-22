"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const erpAuth_1 = require("../middlewares/erpAuth");
const status = (0, erpAuth_1.getErpKeyConfigurationStatus)();
console.log(JSON.stringify(status));
if (!status.valid)
    process.exitCode = 1;
//# sourceMappingURL=diagnoseErpKeys.js.map