import type { Db } from 'mongodb';

/** Read-only order/customer figures for the admin dashboard. Same rules for the local database and the read-only history. */

const ORDER_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'] as const;
const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'] as const;
const PAID = ['completed', 'COMPLETED', 'paid', 'PAID'];
export const CHART_DAYS = 30;
const TZ = 'Asia/Kolkata'; // the store's business day

// Revenue = money actually kept: paid orders that were not cancelled (cancelled-but-paid orders await a manual refund)
const REVENUE_MATCH = { paymentStatus: { $in: PAID }, orderStatus: { $ne: 'cancelled' } };
export const REVENUE_RULE = 'paymentStatus completed and orderStatus not cancelled';

/** Every key present, zero when absent, so the UI can tell a real 0 from a missing field. */
const tally = <K extends string>(keys: readonly K[], rows: { _id: string; n: number }[]) =>
  Object.fromEntries(keys.map((k) => [k, rows.filter((r) => String(r._id).toLowerCase() === k).reduce((a, r) => a + r.n, 0)])) as Record<K, number>;

/** Last CHART_DAYS business days, oldest first, including days without sales. */
const fillDays = (rows: { _id: string; revenue: number; orders: number }[], now = new Date()) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return Array.from({ length: CHART_DAYS }, (_, i) => {
    const date = fmt.format(new Date(now.getTime() - (CHART_DAYS - 1 - i) * 86400000));
    const r = rows.find((x) => x._id === date);
    return { date, revenue: r?.revenue ?? 0, orders: r?.orders ?? 0 };
  });
};

export const orderAndCustomerStats = async (db: Db) => {
  const orders = db.collection('orders');
  const since = new Date(Date.now() - (CHART_DAYS + 1) * 86400000);
  const [totalOrders, latest, totalCustomers, revenueRows, cancelledPaidRows, statusRows, paymentRows, dayRows] = await Promise.all([
    orders.countDocuments(),
    orders.find({}, { projection: { total: 1, orderStatus: 1, paymentStatus: 1, createdAt: 1, user: 1 } }).sort({ createdAt: -1 }).limit(5).toArray(),
    db.collection('users').countDocuments({ role: { $in: ['customer', 'user'] } }),
    orders.aggregate([{ $match: REVENUE_MATCH }, { $group: { _id: null, total: { $sum: '$total' }, orders: { $sum: 1 } } }]).toArray(),
    orders.aggregate([{ $match: { paymentStatus: { $in: PAID }, orderStatus: 'cancelled' } }, { $group: { _id: null, total: { $sum: '$total' }, orders: { $sum: 1 } } }]).toArray(),
    orders.aggregate([{ $group: { _id: '$orderStatus', n: { $sum: 1 } } }]).toArray(),
    orders.aggregate([{ $group: { _id: '$paymentStatus', n: { $sum: 1 } } }]).toArray(),
    orders.aggregate([
      { $match: { ...REVENUE_MATCH, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    ]).toArray(),
  ]);

  // Customer NAME only for recent orders: never email, phone, address or account secrets
  const userIds = [...new Set(latest.map((o) => o.user).filter(Boolean).map(String))];
  const names = new Map((await db.collection('users').find({ _id: { $in: latest.map((o) => o.user).filter(Boolean) } }, { projection: { name: 1 } }).toArray())
    .map((u) => [String(u._id), u.name as string]));
  const recentOrders = latest.map((o) => ({
    _id: String(o._id), total: o.total, orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, createdAt: o.createdAt,
    user: o.user && userIds.includes(String(o.user)) ? { name: names.get(String(o.user)) ?? null } : null,
  }));

  const totalRevenue = revenueRows[0]?.total ?? 0;
  const paidOrders = revenueRows[0]?.orders ?? 0;
  return {
    totalOrders,
    totalCustomers,
    totalRevenue,
    paidOrders,
    averageOrderValue: paidOrders ? Math.round((totalRevenue / paidOrders) * 100) / 100 : 0,
    cancelledPaidAmount: cancelledPaidRows[0]?.total ?? 0,
    cancelledPaidOrders: cancelledPaidRows[0]?.orders ?? 0,
    ordersByStatus: tally(ORDER_STATUSES, statusRows as any),
    paymentsByStatus: tally(PAYMENT_STATUSES, paymentRows as any),
    revenueByDay: fillDays(dayRows as any),
    recentOrders,
  };
};
