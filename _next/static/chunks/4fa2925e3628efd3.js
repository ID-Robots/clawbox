(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,173666,t=>{"use strict";t.s(["createViewTransitionMorph",()=>U,"ensureVtStructuralStyles",()=>K],173666),t.s([],890335),t.i(247167);var e=t.i(174080),r=t.i(248071),n=t.i(186803);let o=0,i=!1,a=!1;function s(){a=!0}function u(t){t.cancelable&&t.preventDefault()}function l(t){t.touches.length>0||(a=!1,0===o&&m())}function m(){i&&(i=!1,document.removeEventListener("touchstart",s,{capture:!0}),document.removeEventListener("touchmove",u,{capture:!0}),document.removeEventListener("touchend",l,{capture:!0}),document.removeEventListener("touchcancel",l,{capture:!0}))}function c(){if("undefined"==typeof document)return()=>{};o+=1,i||(i=!0,a=!1,document.addEventListener("touchstart",s,{capture:!0,passive:!0}),document.addEventListener("touchmove",u,{capture:!0,passive:!1}),document.addEventListener("touchend",l,{capture:!0,passive:!0}),document.addEventListener("touchcancel",l,{capture:!0,passive:!0}));let t=!1;return()=>{!t&&(t=!0,0!=(o-=1)||a||m())}}var d=t.i(850671),p=t.i(200254),h=t.i(175377);let f=t=>Number(t.toFixed(4));function g(t){let[e=0,r=e,n=e,o=r]=t.trim().split(/\s+/).map(t=>Number.parseFloat(t)).filter(t=>Number.isFinite(t)&&t>=0);return[e,r,n,o]}var v=t.i(459546),b=t.i(183103);let y=Symbol.for("ramka.vt.adoptedMarkers");function $(t,e,r=!1){if("undefined"!=typeof document){if((0,b.supportsConstructedSheets)()){var n;let r=(n=document)[y]??(n[y]=new Set);if(r.has(t))return;r.add(t),(0,b.adopt)(e());return}document.head.querySelector(`style[${t}]`)||(0,b.appendStyleElement)(e(),t,r)}}let w="data-ramka-vt-composited",x="data-ramka-vt-composited-css",T=0,E="inset: 0 auto auto 0 !important;",R=`::view-transition-group(${d.VIEW_TRANSITION_NAME})`,A=`::view-transition-old(${d.VIEW_TRANSITION_NAME})`,N=`::view-transition-new(${d.VIEW_TRANSITION_NAME})`;function D(t,e,r){let n="borderRadius"===r?"border-radius":"transform",o=e.map(t=>`${(100*t.offset).toFixed(3)}% { ${n}: ${String(t[r])}; }`).join("\n");return`@keyframes ${t} {
${o}
}`}function C(t){if("string"!=typeof t)return null;let e=t.trim(),r=/^matrix\(([^)]+)\)$/.exec(e);if(r){let t=r[1].split(",").map(t=>Number.parseFloat(t));if(6!==t.length||t.some(t=>!Number.isFinite(t)))return null;let[e,n,o,i,a,s]=t;return Math.abs(n)>.001||Math.abs(o)>.001||e<=0||i<=0?null:{sx:e,sy:i,tx:a,ty:s}}if(r=/^matrix3d\(([^)]+)\)$/.exec(e)){let t=r[1].split(",").map(t=>Number.parseFloat(t));return 16!==t.length||t.some(t=>!Number.isFinite(t))||[t[1],t[2],t[3],t[4],t[6],t[7],t[8],t[9],t[11],t[14]].some(t=>Math.abs(t)>.001)||Math.abs(t[10]-1)>.001||Math.abs(t[15]-1)>.001||t[0]<=0||t[5]<=0?null:{sx:t[0],sy:t[5],tx:t[12],ty:t[13]}}return null}function L(t){if("string"!=typeof t)return null;let e=Number.parseFloat(t);return Number.isFinite(e)&&e>0?e:null}let M=t=>Number(t.toFixed(4));function S(t){"undefined"!=typeof window&&!1!==window.__RAMKA_VT_COMPOSITED__&&t.ready&&t.ready.then(()=>(function(t){let e=document.documentElement,r=e.hasAttribute(h.LightboxDocumentDataAttributes.crossfade);if("function"!=typeof document.getAnimations)return;let n=document.getAnimations().filter(t=>{let e=t.effect;return e?.pseudoElement===R}).find(t=>(t.animationName??"").startsWith("-ua-view-transition-group-anim"));if(!n||!n.effect)return;let o=n.effect,i=[];try{i=o.getKeyframes()}catch{i=[]}let a=i.find(t=>(t.computedOffset??t.offset??0)===0);if(!a)return;let s=C(a.transform),u=L(a.width),l=L(a.height);if(!s||null==u||null==l)return;let m=o.getComputedTiming(),c="number"==typeof m.duration?m.duration:NaN;if(!Number.isFinite(c)||c<=0)return;let{duration:d,ease:y}=(0,v.morphTiming)(),S=n.currentTime,V="number"==typeof S&&Number.isFinite(S)?Math.max(0,Math.min(S,c)):0,I=i.find(t=>(t.computedOffset??t.offset)===1),F=I?C(I.transform):null,P=I?L(I.width):null,O=I?L(I.height):null;if(!F||null==P||null==O){n.pause(),n.currentTime=c;let t=getComputedStyle(e,R);if(F=C(t.transform),P=L(t.width),O=L(t.height),!F||null==P||null==O){n.currentTime=0,n.play();return}}let k=getComputedStyle(e,R),_=k.transformOrigin.split(" ").map(t=>Number.parseFloat(t)),W=Number.parseFloat(k.width),B=Number.parseFloat(k.height),H=Number.isFinite(_[0])&&Number.isFinite(W)&&W>0?_[0]/W:.5,z=Number.isFinite(_[1])&&Number.isFinite(B)&&B>0?_[1]/B:.5;n.cancel();let G="undefined"!=typeof window&&"GestureEvent"in window;G||($("data-ramka-vt-composited-style",()=>`
:root[${w}]${R} {
  animation: none !important;
  transform-origin: 0 0 !important;
}
:root[${w}]:not([${h.LightboxDocumentDataAttributes.crossfade}])${A},
:root[${w}]:not([${h.LightboxDocumentDataAttributes.crossfade}])${N} {
  width: auto !important;
  height: auto !important;
  ${E}
  transform-origin: 0 0 !important;
  animation: none !important;
}
`),e.setAttribute(w,""));let j=getComputedStyle(e),U=g(j.getPropertyValue(p.LightboxDocumentCssVars.morphBorderRadiusFrom)),q=g(j.getPropertyValue(p.LightboxDocumentCssVars.morphBorderRadiusTo)),K=[...U,...q].some(t=>t>0),X=Math.min(120,Math.max(24,Math.round(d/8))),Y=[],Z=[],J=[],Q=[],tt=(t,e,r)=>t+(e-t)*r,te=t=>{let e=tt(u,P,t),r=tt(l,O,t),n=tt(s.sx,F.sx,t),o=tt(s.sy,F.sy,t),i=tt(s.tx,F.tx,t),a=tt(s.ty,F.ty,t),m=e*n,c=r*o,d=null;K&&(d=function(t,e,r,n){let{w0:o,h0:i,w:a,h:s,w1:u,h1:l}=n,m=Math.min(o,i),c=Math.min(u,l),d=Math.min(a,s),p=a>0?a:1,h=s>0?s:1,g=t.map((t,n)=>{var o;let i;return i=m>0?t/m:0,o=e[n],(i+((c>0?o/c:0)-i)*r)*d}),v=g.map(t=>f(t*u/p)),b=g.map(t=>f(t*l/h));return`${v.map(t=>`${t}px`).join(" ")} / ${b.map(t=>`${t}px`).join(" ")}`}(U,q,t,{w0:u,h0:l,w:e,h:r,w1:P,h1:O}));let p=(t,n)=>{let o=Math.max(e/t,r/n),i=(e-o*t)/2*P/e,a=(r-o*n)/2*O/r;return`translate(${M(i)}px, ${M(a)}px) scale(${M(o*P/e)}, ${M(o*O/r)})`};return{group:`translate(${M(i+H*e*(1-n))}px, ${M(a+z*r*(1-o))}px) scale(${M(m/P)}, ${M(c/O)})`,radius:d,old:p(u,l),new:p(P,O)}};for(let t=0;t<=X;t++){let e=t/X,n=te(y(e));Y.push({offset:e,transform:n.group}),K&&Z.push({offset:e,borderRadius:n.radius}),r||(J.push({offset:e,transform:n.old}),Q.push({offset:e,transform:n.new}))}let tr=t=>({duration:d,easing:"linear",fill:"both",pseudoElement:t}),tn=[],to=null;if(G){let t=++T,n=`ramka-vtg-${t}`,o=`ramka-vtr-${t}`,i=`ramka-vto-${t}`,a=`ramka-vtn-${t}`,s=t=>`${t} ${d}ms linear ${-V}ms both`,m=K?`${s(n)}, ${s(o)}`:s(n),c=r?"":`
${D(i,J,"transform")}
${D(a,Q,"transform")}
:root[${x}]${A} {
  width: ${M(u)}px;
  height: ${M(l)}px;
  ${E}
  transform-origin: 0 0 !important;
  animation: ${s(i)} !important;
}
:root[${x}]${N} {
  width: ${M(P)}px;
  height: ${M(O)}px;
  ${E}
  transform-origin: 0 0 !important;
  animation: ${s(a)} !important;
}
`;to=(0,b.insertLibrarySheet)(`
${D(n,Y,"transform")}
${K?D(o,Z,"borderRadius"):""}
:root[${x}]${R} {
  transform-origin: 0 0 !important;
  animation: ${m} !important;
}
${c}`,"data-ramka-vt-composited-css"),e.setAttribute(x,"")}else{try{tn.push(e.animate(Y,tr(R))),K&&tn.push(e.animate(Z,tr(R))),r||(tn.push(e.animate(J,tr(A))),tn.push(e.animate(Q,tr(N))))}catch{for(let t of tn)t.cancel();e.removeAttribute(w),n.currentTime=0,n.play();return}if(V>0)for(let t of tn)t.currentTime=V}t.finished.finally(()=>{for(let t of tn)t.cancel();e.removeAttribute(w),e.removeAttribute(x),to?.release()})})(t)).catch(()=>{})}var V=t.i(610555),I=t.i(929785);function F(t){return document.startViewTransition(t)}function P(){let t="undefined"!=typeof window?window.visualViewport:null;return{innerW:window.innerWidth,innerH:window.innerHeight,vvH:t?.height??null,scrollX:Math.round(window.scrollX),scrollY:Math.round(window.scrollY)}}function O(t){return`${t.innerW}x${t.innerH}|vv:${t.vvH??"n"}|s:${t.scrollX},${t.scrollY}`}function k(t,e){return"both"===t||("opening"===e?"open"===t:"close"===t)}function _(t){let e=getComputedStyle(t).borderRadius.trim();if(!e)return"0px";let{width:r,height:n}=t.getBoundingClientRect();if(!(r>0&&n>0))return"0px";let o=function(t){let e=[],r="",n=0;for(let o of t){if("("===o?n+=1:")"===o&&(n=Math.max(0,n-1)),/\s/.test(o)&&0===n){r&&e.push(r),r="";continue}r+=o}return r&&e.push(r),e}(e.split("/")[0].trim());if(0===o.length)return"0px";let[i,a=i,s=i,u=a]=o,[l,m,c,d]=[i,a,s,u].map(e=>(function(t,e,r){let n=t.trim().toLowerCase();if(!n)return 0;if(/infinity/i.test(n))return 1e9;if(n.endsWith("%")){let t=Number.parseFloat(n);return Number.isFinite(t)?Math.max(0,r*t/100):1e9}let o=Number.parseFloat(n);return Number.isFinite(o)?n.endsWith("rem")?Math.max(0,o*(Number.parseFloat(getComputedStyle(document.documentElement).fontSize)||16)):n.endsWith("em")?Math.max(0,o*(Number.parseFloat(getComputedStyle(e).fontSize)||16)):Math.max(0,o):1e9})(e,t,r)),p=Math.min(1,r/(l+m),r/(d+c),n/(m+c),n/(l+d)),[h,f,g,v]=[l,m,c,d].map(t=>Math.round(t*p*100)/100);return(v===f?g===h?f===h?[h]:[h,f]:[h,f,g]:[h,f,g,v]).map(t=>`${t}px`).join(" ")}function W(t){if(!(0,n.isFirefox)())return null;let e=function(t){let e=t.offsetWidth,r=t.offsetHeight;return e>0&&r>0?{horizontal:e>=document.documentElement.clientWidth-.5,vertical:r>=document.documentElement.clientHeight-.5}:{horizontal:!1,vertical:!1}}(t);if(!e.horizontal&&!e.vertical)return null;let r=t.closest(`[${h.LightboxSlideDataAttributes.slide}]`)??t,o=r.style.paddingLeft,i=r.style.paddingRight,a=r.style.paddingTop,s=r.style.paddingBottom,u=getComputedStyle(r);return e.horizontal&&(r.style.paddingLeft=`${(parseFloat(u.paddingLeft)||0)+1}px`,r.style.paddingRight=`${(parseFloat(u.paddingRight)||0)+1}px`),e.vertical&&(r.style.paddingTop=`${(parseFloat(u.paddingTop)||0)+1}px`,r.style.paddingBottom=`${(parseFloat(u.paddingBottom)||0)+1}px`),t.offsetWidth,()=>{r.style.paddingLeft=o,r.style.paddingRight=i,r.style.paddingTop=a,r.style.paddingBottom=s}}let B=0;function H(t,e,r){t.setAttribute(h.LightboxDocumentDataAttributes.viewTransition,e);var n=r.preset;let o=(0,v.resolveViewTransitionTiming)(n);return t.setAttribute(h.LightboxDocumentDataAttributes.viewTransitionPreset,(0,v.isViewTransitionPreset)(n)?n:"default"),t.style.setProperty(p.LightboxDocumentCssVars.vtDuration,`${o.duration}ms`),t.style.setProperty(p.LightboxDocumentCssVars.vtEasing,o.cssEasing),t.style.setProperty(p.LightboxDocumentCssVars.vtCrossfadeCloseEasing,o.cssCrossfadeCloseEasing),t.style.setProperty(p.LightboxDocumentCssVars.vtRootEasing,o.cssRootEasing),r.useCrossfade?t.setAttribute(h.LightboxDocumentDataAttributes.crossfade,""):(t.style.setProperty(p.LightboxDocumentCssVars.morphOldOpacity,"1"),t.style.setProperty(p.LightboxDocumentCssVars.morphNewOpacity,"opening"===e?"1":"0")),r.fromRadius&&t.style.setProperty(p.LightboxDocumentCssVars.morphBorderRadiusFrom,r.fromRadius),r.toRadius&&t.style.setProperty(p.LightboxDocumentCssVars.morphBorderRadiusTo,r.toRadius),++B}function z(t){t.style.setProperty("view-transition-name",d.VIEW_TRANSITION_NAME,"important")}function G(t){t.style.removeProperty("view-transition-name")}function j(t,e){e===B&&(t.removeAttribute(h.LightboxDocumentDataAttributes.viewTransition),t.removeAttribute(h.LightboxDocumentDataAttributes.crossfade),t.removeAttribute(h.LightboxDocumentDataAttributes.viewTransitionPreset),t.style.removeProperty(p.LightboxDocumentCssVars.morphOldOpacity),t.style.removeProperty(p.LightboxDocumentCssVars.morphNewOpacity),t.style.removeProperty(p.LightboxDocumentCssVars.morphBorderRadiusFrom),t.style.removeProperty(p.LightboxDocumentCssVars.morphBorderRadiusTo),t.style.removeProperty(p.LightboxDocumentCssVars.vtDuration),t.style.removeProperty(p.LightboxDocumentCssVars.vtEasing),t.style.removeProperty(p.LightboxDocumentCssVars.vtCrossfadeCloseEasing),t.style.removeProperty(p.LightboxDocumentCssVars.vtRootEasing))}function U(t){return{open:async()=>{let{decodeMaxWait:n,onBeforeOpenRef:o,beforeOpenAbortRef:i,triggerElementsRef:a,triggerMorphElementsRef:s,activeItemElementRef:u,itemMorphElementsRef:l,openingTriggerIndexRef:m,openingTriggerElementRef:p,closeGenRef:h,commitPrepare:f,commitReveal:g,commitAbortPrepare:v}=t(),b=document.documentElement,y=h.current,$=c(),w=new AbortController;i.current=w;let x=m.current,T=p.current??a.current.get(x)??void 0,E=T?(0,V.findTriggerMorphTarget)(T,s.current):null,R=k(T?.dataset.crossfade,"opening"),A=E?_(E):null;if((0,e.flushSync)(f),n>0){let e=u.current,r=e?(0,V.findItemMorphTarget)(e,l.current):null;if(function(t){if(!t)return null;let e="IMG"===t.tagName?t:t.querySelector("img");return e&&"decode"in e&&(!e.complete||!(e.naturalWidth>0))?e:null}(r)&&(await function(t,e=d.DEFAULT_DECODE_MAX_WAIT){if(!t)return Promise.resolve();let r="IMG"===t.tagName?t:t.querySelector("img");return r&&"decode"in r&&(!r.complete||!(r.naturalWidth>0))?new Promise(t=>{let n=!1,o=()=>{n||(n=!0,t())};r.decode().then(o,o),setTimeout(o,e)}):Promise.resolve()}(r,n),t().closeGenRef.current!==y)){i.current===w&&(i.current=null),$();return}}let N=o.current;if(N){let r=u.current,n=(0,V.findDestinationMorphTarget)(r,l.current,t().destinationMorphElementRef.current);try{await N({destination:n,signal:w.signal})}catch{i.current===w&&(i.current=null),t().closeGenRef.current===y&&(0,e.flushSync)(v),$();return}if(i.current===w&&(i.current=null),t().closeGenRef.current!==y)return void $();if(w.signal.aborted){(0,e.flushSync)(v),$();return}}else i.current===w&&(i.current=null);if(!("undefined"!=typeof navigator&&/jsdom/i.test(navigator.userAgent))&&(0,r.isAndroidBlinkSnapshotRoot)()&&(await ("undefined"!=typeof navigator&&/jsdom/i.test(navigator.userAgent)?Promise.resolve():new Promise(t=>{let e=performance.now(),r=O(P()),n=0,o=()=>{let i=P(),a=O(i),s=null==i.vvH||1>=Math.abs(i.innerH-i.vvH),u=performance.now()-e;if(a===r&&s?n+=1:(r=a,n=0),n>=8||u>=1e3&&s||u>=1500)return void t();requestAnimationFrame(o)};requestAnimationFrame(o)})),t().closeGenRef.current!==y)){(0,e.flushSync)(v),$();return}let D=u.current,C=(0,V.findDestinationMorphTarget)(D,l.current,t().destinationMorphElementRef.current),L=!!E&&function(t){if(!t)return!1;let e=t.getBoundingClientRect();return e.width>0&&e.height>0}(C);L&&D;let M=L?_(C):null,B=H(b,"opening",{useCrossfade:!L||R,fromRadius:L?A:null,toRadius:M,preset:t().transitionPreset});L&&z(E);let U=null,q=F(()=>{L&&G(E),(0,e.flushSync)(g);let r=u.current;if(L){let e=(0,V.findDestinationMorphTarget)(r,l.current,t().destinationMorphElementRef.current);e&&(z(e),U=W(e))}r&&r.setAttribute("data-skip-fade","")});L&&S(q),q.finished.finally(()=>{if($(),U?.(),U=null,t().closeGenRef.current!==y)return;let e=t(),r=e.activeItemElementRef.current,n=(0,V.findDestinationMorphTarget)(r,e.itemMorphElementsRef.current,e.destinationMorphElementRef.current);n&&G(n),j(b,B);let o=(0,I.resolveScrollTriggerOption)(e.scrollTriggerIntoView,"onOpenComplete");if(o){let t=(0,I.resolveTriggerIndex)(e.activeIndexRef.current,e.morphTo,e.openingTriggerIndexRef.current,e.triggerElementsRef.current);(0,I.scrollTriggerEl)(e.triggerElementsRef.current.get(t),o)}e.onOpenComplete()})},close:()=>{let{morphTo:r,scrollTriggerIntoView:o,triggerElementsRef:i,triggerMorphElementsRef:a,activeItemElementRef:s,itemMorphElementsRef:u,destinationMorphElementRef:l,openingTriggerIndexRef:m,activeIndexRef:d,closeGenRef:p,commitClose:h}=t(),f=document.documentElement,g=p.current,v=c(),b=s.current,y=(0,V.findDestinationMorphTarget)(b,u.current,l.current),$=(0,I.resolveTriggerIndex)(d.current,r,m.current,i.current),w=i.current.get($),x=w?(0,V.findTriggerMorphTarget)(w,a.current):null,T=!!x&&!!y,E=!T||k(w?.dataset.crossfade,"closing"),R=H(f,"closing",{useCrossfade:E,fromRadius:T?_(y):null,toRadius:T?_(x):null,preset:t().transitionPreset});if((0,n.isFirefox)()){let e=t().activeZoomRef.current;e&&e.getZoom()>1&&e.reset(!0)}let A=null;T&&(A=W(y),z(y));let N=F(()=>{A?.(),A=null,T&&G(y),(0,e.flushSync)(h);let t=(0,I.resolveScrollTriggerOption)(o,"onClose");t&&(0,I.scrollTriggerEl)(w,t),T&&z(x)});T&&S(N),N.finished.finally(()=>{v(),A?.(),A=null,T&&G(x),j(f,R),t().closeGenRef.current===g&&t().onCloseComplete(w)})}}}function q(){let t=h.LightboxDocumentDataAttributes.viewTransition,e=h.LightboxDocumentDataAttributes.crossfade,r=h.LightboxTriggerDataAttributes.morphTarget,n=h.LightboxSlidesDataAttributes.slides,o=p.LightboxDocumentCssVars,i=v.VIEW_TRANSITION_PRESETS.default,a=`::view-transition-group(${d.VIEW_TRANSITION_NAME})`,s=`::view-transition-old(${d.VIEW_TRANSITION_NAME})`,u=`::view-transition-new(${d.VIEW_TRANSITION_NAME})`,l=`var(${o.vtDuration}, ${i.duration}ms)`,m=`var(${o.vtEasing}, ${i.cssEasing})`,c=`var(${o.vtCrossfadeCloseEasing}, ${i.cssCrossfadeCloseEasing})`,f=`var(${o.vtRootEasing}, ${i.cssRootEasing})`,g=`calc(${l} * 0.48)`;return`
/* Isolate the lightbox morph from the rest of the page. startViewTransition
   captures the WHOLE document, so any consumer element carrying its own
   view-transition-name would be lifted into a separate group and painted on
   the VT layer over the backdrop. Neutralize every name while the morph runs;
   the morph target re-declares its name inline with !important, which
   outranks this author-!important rule on specificity. */
:root[${t}] * {
  view-transition-name: none !important;
}

/* Hide the live morph source while the VT layer owns its pixels (the library
   sets ${r} on the resolved morph element). Without this the
   original trigger shows doubled under the morphing snapshot. The fade-back
   covers the close handover; it is killed DURING the transition so it can't
   be captured mid-flight in the root snapshot. */
[${r}] {
  opacity: 0;
  transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

:root[${t}] [${r}] {
  transition: none;
}

@media (prefers-reduced-motion: no-preference) {
  /* Root snapshot cross-fade \u2014 the page-behind transition. Kept as a SINGLE
     root group: WebKit rasterizes each named group on the CPU. Lightbox
     chrome (thumbnails, zoom controls) fades with this snapshot \u2014 never as
     its own fullscreen named group. */
  :root[${t}]::view-transition-old(root),
  :root[${t}]::view-transition-new(root) {
    animation-duration: ${l};
    animation-timing-function: ${f};
  }

  /* Shape morph is CSS-only: JS writes the from/to radius vars; the group
     owns clipping for the whole transition. The 'from' radius is the cascade
     base (not only a keyframe) so frame 0 can't flash the 0px fallback. */
  @keyframes ramka-morph-border-radius {
    to {
      border-radius: var(${o.morphBorderRadiusTo}, 0px);
    }
  }

  ${a} {
    overflow: hidden;
    border-radius: var(${o.morphBorderRadiusFrom}, 0px);
    animation-name: -ua-view-transition-group-anim-${d.VIEW_TRANSITION_NAME}, ramka-morph-border-radius;
    animation-duration: ${l};
    animation-timing-function: ${m};
    animation-fill-mode: both;
    z-index: 2;
  }

  /* Hard-cut default (Trigger omits crossfade). Cover keeps same-image crops
     coherent; kill the UA dissolve and drive opacity from library vars. */
  ${s},
  ${u} {
    object-fit: cover;
    width: 100%;
    height: 100%;
    animation: none !important;
    mix-blend-mode: normal;
  }

  ${s} {
    opacity: var(${o.morphOldOpacity}, 1);
  }

  ${u} {
    opacity: var(${o.morphNewOpacity}, 0);
  }

  /* Dissolve path (Trigger crossfade): restore the UA fade, plus-lighter
     blend, fill so circular triggers don't balloon under cover. Re-timed to
     the preset vars so the dissolve runs on the morph's clock (the UA
     default would end at 250ms, mid-morph). Open uses the morph ease-out so
     the destination appears promptly while the group grows; close uses a
     modest ease-out (not the morph curve \u2014 that flashes a stretched trigger
     in the first frames, and a strong ease-in holds the item too long).
     Both phases share one complementary 1\u21920 / 0\u21921 pair on a shorter window
     so the outgoing snapshot is gone before the size settle (a face or +N
     overlay must not ghost until t=1). Do not delay one snapshot relative
     to the other \u2014 that leaves a window where opacities no longer sum to 1.

     Fill-mode both: the UA fades run with fill none, so a finished fade
     snaps the old snapshot back to its base opacity of 1 \u2014 and the
     composited group replacement can outlive the fades by a frame (its
     animations attach one style flush later), which painted a fully-opaque
     trigger snapshot blended over the item for that frame. Holding the end
     state closes the gap. */
  :root[${e}]${s},
  :root[${e}]${u} {
    object-fit: fill;
    mix-blend-mode: plus-lighter;
    animation: revert !important;
    animation-duration: ${g} !important;
    animation-timing-function: ${m} !important;
    animation-fill-mode: both !important;
    opacity: revert;
  }

  :root[${t}="closing"][${e}]${s},
  :root[${t}="closing"][${e}]${u} {
    animation-timing-function: ${c} !important;
  }
}

/* Thumb-jump slides crossfade \u2014 the element-scoped view transition started by
   ThumbnailStrip's selectViewTransition. Tunable via the select-vt vars. */
[${n}]::view-transition-group(root) {
  animation-duration: var(${p.LightboxThumbnailStripCssVars.selectVtDuration}, 0.4s);
  animation-timing-function: var(${p.LightboxThumbnailStripCssVars.selectVtEasing}, cubic-bezier(0.22, 1, 0.36, 1));
}

[${n}]::view-transition-old(root),
[${n}]::view-transition-new(root) {
  mix-blend-mode: normal;
  height: 100%;
  overflow: clip;
}
`}function K(){$("data-ramka-lightbox-vt-styles",q,!0)}t.i(890335)}]);