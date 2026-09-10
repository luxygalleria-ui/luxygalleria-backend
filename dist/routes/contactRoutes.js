"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const contactController_1 = require("../controllers/contactController");
const authMiddleware_1 = require("../middlewares/authMiddleware");
const router = (0, express_1.Router)();
// Public route for frontend
router.post('/', contactController_1.submitContactForm);
// Admin routes
router.get('/', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), contactController_1.getContacts);
router.put('/:id/read', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), contactController_1.markContactAsRead);
router.put('/:id/status', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), contactController_1.updateContactStatus);
router.delete('/:id', authMiddleware_1.protect, (0, authMiddleware_1.authorize)('admin', 'superadmin'), contactController_1.deleteContact);
exports.default = router;
//# sourceMappingURL=contactRoutes.js.map