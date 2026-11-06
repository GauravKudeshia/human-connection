// A single projection is used by receipts and regression tests. Historical charges
// remain visible after refunds; unpaid quotes are never represented as charges.
export function receiptFor(booking) {
  const baseCharge = booking.payment === "UNPAID" ? 0 : booking.totalCents;
  const baseRefund = booking.payment === "SIMULATED_REFUNDED" ? baseCharge : 0;
  const tipCharge = booking.tipCents || 0;
  const tipRefund = booking.tipRefunded ? tipCharge : 0;
  return {
    baseCharge,
    baseRefund,
    tipCharge,
    tipRefund,
    net: baseCharge - baseRefund + tipCharge - tipRefund,
    sessionStatus: booking.status,
    paymentStatus: booking.payment,
    realCharge: 0,
  };
}
