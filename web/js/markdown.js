import {escapeHtml} from "./util.js";

// Message text to safe HTML: model tags (<thought>, <tool_call>) are lifted out, raw HTML outside code is escaped,
// markdown is rendered by the vendored `marked`, and links are restricted to http(s)/mailto.

function splitCodeFences(text){
  if(!text) return [];
  const regex = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while((match = regex.exec(text)) !== null){
    if(match.index > lastIndex){
      parts.push({type: "text", content: text.slice(lastIndex, match.index)});
    }
    parts.push({type: "code", content: match[0]});
    lastIndex = regex.lastIndex;
  }
  if(lastIndex < text.length){
    parts.push({type: "text", content: text.slice(lastIndex)});
  }
  return parts;
}
export function extractModelTags(text){
  if(!text) return {thoughts: [], toolCalls: [], activeThought: "", cleanText: ""};
  const parts = splitCodeFences(String(text));
  const thoughts = [];
  const toolCalls = [];
  let activeThought = "";

  const cleanParts = parts.map((part, pIdx)=>{
    if(part.type === "code") return part.content;
    let clean = part.content;

    clean = clean.replace(/<(?:thought|reasoning)>([\s\S]*?)<\/(?:thought|reasoning)>/gi, (match, inner)=>{
      if(inner.trim()) thoughts.push(inner.trim());
      return "";
    });

    if(pIdx === parts.length - 1){
      const openThoughtMatch = clean.match(/<(?:thought|reasoning)>([\s\S]*)$/i);
      if(openThoughtMatch){
        activeThought = openThoughtMatch[1].trim();
        clean = clean.slice(0, openThoughtMatch.index);
      }
    }

    clean = clean.replace(/<tool_call>([\s\S]*?)<\/tool_call>/gi, (match, inner)=>{
      const trimmed = inner.trim();
      if(trimmed){
        try{ toolCalls.push(JSON.parse(trimmed)); }
        catch{ toolCalls.push({raw: trimmed}); }
      }
      return "";
    });

    if(pIdx === parts.length - 1){
      const openToolMatch = clean.match(/<tool_call>([\s\S]*)$/i);
      if(openToolMatch){
        clean = clean.slice(0, openToolMatch.index);
      }
    }

    return clean;
  });

  return {thoughts, toolCalls, activeThought, cleanText: cleanParts.join("").trim()};
}

/* ---------- markdown + Hermes-aware rendering ---------- */
// Hermes wraps meta/context content in bracketed headers, e.g.
//   [CONTEXT COMPACTION — REFERENCE ONLY] ...   [PRIOR CONTEXT — ...]   [SYSTEM ...]
// Render those as de-emphasized "system note" callouts; render the rest as markdown.
const SYSNOTE_RE = /^\[([A-Z][A-Z0-9 _\-–—]+)(?:[ —–]+(.*?))?\]/;
function splitSysNotes(text){
  const lines = text.split("\n");
  const out = []; let i = 0;
  while(i < lines.length){
    const m = lines[i].match(SYSNOTE_RE);
    if(m && lines[i].startsWith("[")){
      const label = m[1]; const sub = m[2]||"";
      const after = lines[i].slice(m[0].length).replace(/^\s*/, "");
      const bodyLines = []; if(after) bodyLines.push(after); let j = i+1;
      while(j < lines.length){
        const ln = lines[j];
        if(ln.trim()===""){
          let k=j+1; while(k<lines.length && lines[k].trim()==="") k++;
          if(k<lines.length && lines[k].match(SYSNOTE_RE) && lines[k].startsWith("[")) break;
          bodyLines.push(ln); j++; continue;
        }
        if(ln.match(SYSNOTE_RE) && ln.startsWith("[")) break;
        bodyLines.push(ln); j++;
      }
      out.push({type:"note", label, sub, body: bodyLines.join("\n").trim()});
      i = j;
    } else {
      const md = [];
      while(i < lines.length){
        const ln = lines[i];
        if(ln.match(SYSNOTE_RE) && ln.startsWith("[")) break;
        md.push(ln); i++;
      }
      if(md.join("\n").trim()) out.push({type:"md", text: md.join("\n")});
    }
  }
  return out;
}
function renderMarkdown(text){
  if(text==null) return "";
  const blocks = splitSysNotes(String(text));
  let html = "";
  for(const b of blocks){
    if(b.type==="note"){
      const body = b.body ? marked.parse(b.body, {breaks:true, gfm:true}) : "";
      const head = escapeHtml((b.label||"note") + (b.sub? " — "+b.sub : ""));
      html += "<div class='sysnote'><div class='sysnote-h'>"+head+"</div>"+(body?"<div class='sysnote-b'>"+body+"</div>":"")+"</div>";
    }else{
      html += marked.parse(b.text, {breaks:true, gfm:true});
    }
  }
  return html;
}
function safeHref(value){
  const raw=String(value||"").trim();
  if(!raw) return null;
  try{
    const url=new URL(raw, document.baseURI);
    if(["http:","https:","mailto:"].includes(url.protocol)) return url.href;
  }catch{ /* unparseable URL: fall through to null */ }
  return null;
}
function secureHtml(html){
  return String(html||"").replace(/<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*)>/gi, (match, before, quote, url, after) => {
    const safe = safeHref(url);
    if(!safe) return `<a ${before} ${after}>`;
    return `<a ${before}href="${safe}" rel="noreferrer noopener"${after}>`;
  });
}
export function setBody(el, text){ setCleanBody(el, extractModelTags(text).cleanText); }
// `cleanText` has already had thought/tool_call tags removed (see extractModelTags).
export function setCleanBody(el, cleanText){
  const parts = splitCodeFences(cleanText);
  const safeParts = parts.map(part => {
    if(part.type === "code") return part.content;
    return part.content.replace(/<(?=[a-zA-Z\/!\?])/gi, "&lt;");
  });
  el.innerHTML = secureHtml(renderMarkdown(safeParts.join("")));
}
