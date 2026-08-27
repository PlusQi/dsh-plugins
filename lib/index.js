/**
 * dsh-plugins node half. Pure UI pack: the empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; every browser plugin ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. Future pack plugins add their slot registrations in
 * lib/client.js and a row in cordis.patch.yml - no reinstall needed.
 */
function apply() {}
export { apply };
