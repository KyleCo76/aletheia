//! XML-attribute response builder for V2 MCP tool responses.
//!
//! Phase 4 S1 ships `XmlElement` — the response struct + serializer that
//! every Phase 5 tool will use to produce V1-compatible XML output (see
//! plan §"5.4 Phase 5 contracts" + plan lines 2303-2334).
//!
//! ## Design principles
//!
//! Two cross-cutting principles dictate the shape of this module:
//!
//! 1. **Visible-dedup principle** (plan §"Constraints from design"):
//!    every server-side deviation (write_routing, dedup hits, auto-table
//!    inferences) MUST surface in the tool response. Phase 5 tools build
//!    this with `XmlElement::attr` chains.
//!
//! 2. **Visible-failure principle** (arranger-handoff + W1 §6.2bis MUST-1):
//!    error responses MUST be helpful — five attributes (`code`,
//!    `parameter`, `value`, `reason`, `hint`) tell the caller WHY their
//!    call failed AND what to do next. The `error()` helper enforces the
//!    shape; tools cannot opt out by emitting partial errors.
//!
//! ## Attribute ordering
//!
//! Attributes serialize in **alphabetical order** (BTreeMap iteration).
//! This is load-bearing for test stability — tools that compose
//! responses via different code paths produce byte-identical output if
//! the attribute set is identical. Production code MUST NOT depend on a
//! particular non-alphabetical ordering.
//!
//! ## Escaping
//!
//! `to_string` escapes the five XML control characters in both attribute
//! values and text content: `&`, `<`, `>`, `"`, `'`. The escapes are the
//! canonical entity references (`&amp;`, `&lt;`, etc.). No CDATA — tools
//! that need to carry arbitrary user-supplied text should pass it
//! through `text(...)`, which gets the same escaping treatment.
//!
//! ## V3 extension seam
//!
//! Q7 IS-6 calls out `<duplicate>` as extensible: V3's KG layer will add
//! a `related_entries` attribute non-breaking. Because `XmlElement::attrs`
//! is a `BTreeMap<String, String>` rather than a strongly-typed struct,
//! V3 simply adds another `.attr()` call site — no schema migration.

use std::collections::BTreeMap;

/// A single XML element rendered with attribute-style payload.
///
/// V2's tool responses are XML-attribute heavy by design (the V1
/// convention preserved by plan §"5.4 Phase 5 contracts"). This struct
/// is intentionally permissive: tools can mix attributes, text, and
/// child elements freely. The Phase 5 helper constructors below
/// (`entry`, `duplicate`, `error`) are the load-bearing shapes — most
/// tools should use them rather than rolling their own.
#[derive(Debug, Clone)]
pub struct XmlElement {
    /// Tag name, e.g. `"entry"`, `"duplicate"`, `"error"`.
    pub tag: String,
    /// Attributes; rendered in alphabetical order (BTreeMap iteration).
    pub attrs: BTreeMap<String, String>,
    /// Nested child elements, rendered in insertion order.
    pub children: Vec<XmlElement>,
    /// Optional text body; coexists with children for mixed-content cases.
    pub text: Option<String>,
}

impl XmlElement {
    /// Create an empty element with the given tag and no attrs / children / text.
    pub fn new(tag: impl Into<String>) -> Self {
        Self {
            tag: tag.into(),
            attrs: BTreeMap::new(),
            children: Vec::new(),
            text: None,
        }
    }

    /// Add an attribute. Chainable. If the key already exists it is overwritten.
    pub fn attr(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.attrs.insert(key.into(), value.into());
        self
    }

    /// Append a child element. Chainable.
    pub fn child(mut self, child: XmlElement) -> Self {
        self.children.push(child);
        self
    }

    /// Set the text body. Chainable. A subsequent call overwrites the prior text.
    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }

    /// Helper: success shape for entry-creating tools (`create_entry`,
    /// `write_memory`, `write_journal`, etc.). Phase 5 contract C-S8.
    ///
    /// Produces `<entry id="..." scope="..." routing="..."/>`. Tools that
    /// need to add extra metadata (e.g. `scope_alias`, `dedup_status`)
    /// chain `.attr()` calls afterwards.
    pub fn entry(
        id: impl Into<String>,
        scope: impl Into<String>,
        routing: impl Into<String>,
    ) -> Self {
        Self::new("entry")
            .attr("id", id)
            .attr("scope", scope)
            .attr("routing", routing)
    }

    /// Helper: dedup hit shape for `write_memory` (Phase 5 contract).
    ///
    /// Produces
    /// `<duplicate existing_entry_id="..." existing_version="..." message="..."/>`.
    /// Q7 IS-6: this shape is the V2 → V3 extension seam (V3 adds
    /// `related_entries` attr non-breaking).
    pub fn duplicate(
        existing_entry_id: impl Into<String>,
        existing_version: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::new("duplicate")
            .attr("existing_entry_id", existing_entry_id)
            .attr("existing_version", existing_version)
            .attr("message", message)
    }

    /// Helper: helpful-failure shape (W1 §6.2bis MUST-1 + arranger-handoff
    /// Visible-failure principle). The five fields are LOAD-BEARING — the
    /// caller-side error UX expects all five to be present so error
    /// messages are actionable.
    ///
    /// Produces
    /// `<error code="..." hint="..." parameter="..." reason="..." value="..."/>`
    /// (note alphabetical attribute order from BTreeMap — verified in the
    /// unit tests below).
    pub fn error(
        code: impl Into<String>,
        parameter: impl Into<String>,
        value: impl Into<String>,
        reason: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self::new("error")
            .attr("code", code)
            .attr("parameter", parameter)
            .attr("value", value)
            .attr("reason", reason)
            .attr("hint", hint)
    }

    fn write_to(&self, buf: &mut String) {
        buf.push('<');
        buf.push_str(&self.tag);
        // BTreeMap iteration is alphabetical — load-bearing for test stability.
        for (k, v) in &self.attrs {
            buf.push(' ');
            buf.push_str(k);
            buf.push_str("=\"");
            escape_into(v, buf);
            buf.push('"');
        }
        if self.children.is_empty() && self.text.is_none() {
            buf.push_str("/>");
            return;
        }
        buf.push('>');
        if let Some(ref t) = self.text {
            escape_into(t, buf);
        }
        for child in &self.children {
            child.write_to(buf);
        }
        buf.push_str("</");
        buf.push_str(&self.tag);
        buf.push('>');
    }
}

/// `Display` is the load-bearing rendering surface. The brief asks for
/// `to_string(&self) -> String`; we provide it via `Display`'s blanket
/// impl on `String::from(x)` / `x.to_string()` (the `ToString` trait is
/// auto-implemented for every `T: Display`). Clippy rejects an inherent
/// `to_string` method that shadows the `ToString` impl — see
/// `clippy::inherent_to_string`. Production call sites use `element.to_string()`
/// identically and get the same bytes; the lint just steers us to the
/// idiomatic implementation route.
impl std::fmt::Display for XmlElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut buf = String::new();
        self.write_to(&mut buf);
        f.write_str(&buf)
    }
}

/// Escape the five XML control characters into `buf`. Used identically
/// for attribute values and text body content (no CDATA path).
fn escape_into(s: &str, buf: &mut String) {
    for c in s.chars() {
        match c {
            '&' => buf.push_str("&amp;"),
            '<' => buf.push_str("&lt;"),
            '>' => buf.push_str("&gt;"),
            '"' => buf.push_str("&quot;"),
            '\'' => buf.push_str("&apos;"),
            other => buf.push(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_closing_with_attrs_alphabetical() {
        let e = XmlElement::new("entry")
            .attr("scope", "primary")
            .attr("routing", "explicit")
            .attr("id", "abc123");
        // Attributes serialize alphabetically regardless of insertion order.
        assert_eq!(
            e.to_string(),
            r#"<entry id="abc123" routing="explicit" scope="primary"/>"#
        );
    }

    #[test]
    fn element_with_text_body() {
        let e = XmlElement::new("note").attr("kind", "info").text("hello");
        assert_eq!(e.to_string(), r#"<note kind="info">hello</note>"#);
    }

    #[test]
    fn element_with_children_and_alphabetical_attrs() {
        // Build a parent with attrs in non-alphabetical insertion order,
        // verify they emerge alphabetical and children come after.
        let parent = XmlElement::new("result")
            .attr("z", "z-val")
            .attr("a", "a-val")
            .child(XmlElement::new("entry").attr("id", "1"))
            .child(XmlElement::new("entry").attr("id", "2"));
        assert_eq!(
            parent.to_string(),
            r#"<result a="a-val" z="z-val"><entry id="1"/><entry id="2"/></result>"#
        );
    }

    #[test]
    fn escapes_all_five_xml_control_chars_in_attr_and_text() {
        // Each of `& < > " '` must escape to the canonical entity ref
        // in BOTH attribute values and text bodies.
        let raw = r#"a & b < c > d " e ' f"#;
        let escaped = r#"a &amp; b &lt; c &gt; d &quot; e &apos; f"#;

        let e = XmlElement::new("danger").attr("payload", raw).text(raw);
        let s = e.to_string();
        // The attribute value and the text body both end up escaped.
        let expected = format!(r#"<danger payload="{escaped}">{escaped}</danger>"#);
        assert_eq!(s, expected);
    }

    #[test]
    fn entry_helper_shape() {
        let e = XmlElement::entry("e_42", "scope_alpha", "primary");
        assert_eq!(
            e.to_string(),
            r#"<entry id="e_42" routing="primary" scope="scope_alpha"/>"#
        );
    }

    #[test]
    fn duplicate_helper_shape() {
        let d = XmlElement::duplicate("e_existing", "v3", "Same content_hash");
        assert_eq!(
            d.to_string(),
            r#"<duplicate existing_entry_id="e_existing" existing_version="v3" message="Same content_hash"/>"#
        );
    }

    /// C-S8: error helper produces the canonical helpful-failure shape.
    /// All five attributes (code, hint, parameter, reason, value) MUST
    /// be present; attribute order is alphabetical.
    #[test]
    fn error_helper_has_five_alphabetical_attrs() {
        let e = XmlElement::error(
            "INVALID_SCOPE",
            "scope",
            "no-such-scope",
            "Scope does not exist",
            "Run list_keys to see scopes you can write to.",
        );
        // Alphabetical: code, hint, parameter, reason, value.
        assert_eq!(
            e.to_string(),
            r#"<error code="INVALID_SCOPE" hint="Run list_keys to see scopes you can write to." parameter="scope" reason="Scope does not exist" value="no-such-scope"/>"#
        );
    }

    /// C-S8: error helper escapes XML control chars inside its attributes.
    /// A `value="<bad>"` payload from a real call must not break the
    /// envelope or smuggle a fake child element.
    #[test]
    fn error_helper_escapes_attr_values() {
        let e = XmlElement::error(
            "BAD_INPUT",
            "name",
            r#"<inj/>"#,
            "rejected",
            "use [a-z0-9_-]",
        );
        let s = e.to_string();
        assert!(
            s.contains(r#"value="&lt;inj/&gt;""#),
            "value must escape: {s}"
        );
        // Round-trip-defensive: the literal `<inj/>` must not appear unescaped.
        assert!(!s.contains("<inj/>"), "raw injection must not appear: {s}");
    }

    /// to_string is invoked through Display-style usage in Phase 5
    /// tool bodies; sanity-check that it returns owned String (no
    /// borrow-of-self trickery that would break call-site patterns).
    #[test]
    fn to_string_returns_owned_string() {
        let e = XmlElement::new("x");
        let s: String = e.to_string();
        assert_eq!(s, "<x/>");
        // e is still usable after to_string (no move).
        let s2 = e.to_string();
        assert_eq!(s, s2);
    }
}
