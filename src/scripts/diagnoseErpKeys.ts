import 'dotenv/config';
import { getErpKeyConfigurationStatus } from '../middlewares/erpAuth';

const status = getErpKeyConfigurationStatus();
console.log(JSON.stringify(status));
if (!status.valid) process.exitCode = 1;