/** A product-managed workspace: a packaged account build (its workspace window is launched with
 * `--omb-product-managed=1`, which is the only time `window.ogb.productAccount` exists) or a dev
 * server started with `OMB_PRODUCT_SERVICE_URL`. The bridge outlives the first config frame, so the
 * window never flashes the ordinary onboarding while the server is still starting. */
export function isProductWorkspace(managed?: boolean): boolean {
  return managed === true || Boolean(typeof window !== "undefined" && window.ogb?.productAccount);
}
