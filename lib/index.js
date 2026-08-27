/**
 * dsh-plugins node half. Pure UI pack: the empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; every browser plugin ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. Each cordis.patch.yml row activates one pack plugin through
 * config.plugin, dispatched to its registration block in lib/client.js (one
 * module, one fiber per row). A future pack plugin needing host-side code
 * would dispatch on the same config.plugin here.
 */
function apply() {}
export { apply };
