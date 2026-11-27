window.__ModuleLoader__.load({
  id: "dsh-formation",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = null
    try { React = require("react") } catch { React = null }

    function FormationPanel() {
      if (!React) return null
      return React.createElement("iframe", {
        src: "/dsh-formation",
        title: "编队设置",
        style: { width: "100%", height: "100%", border: "0", background: "#0f1115" }
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.desktopWorkbenches.register({
        title: "编队设置",
        panelTitle: "编队设置",
        description: "定编制、开工作区；编制是并发上限，实际人数按任务量钳制。含自测、诊断与日志",
        category: "交付",
        icon: "队",
        customFrame: true
      }, FormationPanel))
    }

    exports.name = "dsh-formation"
    exports.inject = ["desktopWorkbenches"]
    exports.apply = apply

    return module.exports
  }
})
