import {
  Node,
  mergeAttributes
} from "./chunk-RFDYFW6U.js";
import "./chunk-V4F5PRXT.js";

// node_modules/@tiptap/extension-table-row/dist/index.js
var TableRow = Node.create({
  name: "tableRow",
  addOptions() {
    return {
      HTMLAttributes: {}
    };
  },
  content: "(tableCell | tableHeader)*",
  tableRole: "row",
  parseHTML() {
    return [{
      tag: "tr"
    }];
  },
  renderHTML({
    HTMLAttributes
  }) {
    return ["tr", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  }
});
export {
  TableRow,
  TableRow as default
};
//# sourceMappingURL=@tiptap_extension-table-row.js.map
