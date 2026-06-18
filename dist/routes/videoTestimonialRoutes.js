"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const videoTestimonialController_1 = require("../controllers/videoTestimonialController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = express_1.default.Router();
// Public route for landing page
router.get('/active', videoTestimonialController_1.getActiveVideoTestimonials);
// Admin routes (require login and admin/superadmin role)
router.use(authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'));
router.route('/')
    .get(videoTestimonialController_1.getVideoTestimonials)
    .post(videoTestimonialController_1.createVideoTestimonial);
router.route('/:id')
    .put(videoTestimonialController_1.updateVideoTestimonial)
    .delete(videoTestimonialController_1.deleteVideoTestimonial);
exports.default = router;
//# sourceMappingURL=videoTestimonialRoutes.js.map