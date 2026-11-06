/* Optional synchronous head script: restore color mode, design and cached palette
   before CSS paints. Runtime customization still works with ui.css + ui.js alone. */
(() => {
  'use strict';
  const root=document.documentElement;
  const base=document.createElement('style');
  base.textContent='html{background:var(--bs-body-bg,#f4f3f0);color-scheme:light}html[data-bs-theme="dark"]{background:var(--bs-body-bg,#1b1c1e);color-scheme:dark}';document.head.append(base);
  const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
  const modes=['light','dark','system'],designs=['default','glass','glassmorphism','flat','soft'];
  const palettes=['default','slate','sage','teal','mauve','sand','clay','custom'];
  const mode=read('kav-ui-theme'),design=read('kav-ui-design-theme'),palette=read('kav-ui-palette');
  const selected=modes.includes(mode)?mode:'system';
  root.dataset.uiColorPreference=selected;
  root.dataset.bsTheme=selected==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):selected;
  let cached=null;
  try {const saved=read('kav-ui-custom-palette');if(saved && saved.length<32768)cached=JSON.parse(saved);} catch { /* Invalid saved data is optional. */ }
  const hex=value=>typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value);
  const validCache=record=>[1,2].includes(record?.version) && hex(record.seed) && Number.isInteger(record.chroma) && record.chroma>=0 && record.chroma<=32 && ['light','dark'].every(mode=>{
    const properties=record[mode];
    return properties && typeof properties==='object' && ['--bs-primary','--ui-on-primary','--bs-body-bg','--bs-body-color'].every(key=>hex(properties[key])) && Object.entries(properties).every(([key,value])=>/^--(?:md-sys-color-[a-z-]+|ui-color-[a-z-]+|bs-[a-z-]+|ui-(?:control-outline|on-[a-z-]+))$/.test(key) && hex(value));
  });
  let hasCache=validCache(cached);
  // Old caches already contain the exact HCT tones needed for quieter surfaces.
  // Migrate in memory before the first paint; keep the stored seed/chroma intact.
  if(hasCache && cached.version===1) {
    const values=cached.light,oldSurface=values['--md-sys-color-surface'],surface=values['--md-sys-color-surface-container-low'];
    if(hex(oldSurface)&&hex(surface)) {
      values['--md-sys-color-surface-container-lowest']=oldSurface;
      values['--md-sys-color-surface']=values['--bs-body-bg']=surface;
      cached.version=2;
    } else hasCache=false;
  }
  const restore=()=>{
    if(!document.body)return false;
    if(!document.body.hasAttribute('data-ui-theme-persist'))return true;
    if(!document.body.hasAttribute('data-ui-theme') && designs.includes(design))document.body.dataset.uiTheme=design;
    const explicitSeed=root.getAttribute('data-ui-palette-seed');
    const explicitChroma=root.getAttribute('data-ui-palette-chroma');
    const matchingCache=hasCache && (!explicitSeed || (explicitSeed.toLowerCase()===cached.seed && Number(explicitChroma??24)===cached.chroma));
    if(matchingCache) {
      const style=document.createElement('style');style.setAttribute('data-ui-custom-palette-style','');
      style.textContent=['light','dark'].map(mode=>{
        const values=cached[mode],primary=values['--bs-primary'];
        const rgb=[1,3,5].map(index=>parseInt(primary.slice(index,index+2),16)).join(', ');
        return (mode==='dark'?':root[data-bs-theme="dark"][data-ui-palette="custom"]':':root[data-ui-palette="custom"]')+'{'+Object.entries(values).map(([key,value])=>key+':'+value+';').join('')+'--bs-primary-rgb:'+rgb+';}';
      }).join('\n');document.head.append(style);
    }
    if(!palettes.includes(root.dataset.uiPalette) && palettes.includes(palette) && (palette!=='custom' || matchingCache))root.dataset.uiPalette=palette;
    return true;
  };
  if(!restore()) {
    const observer=new MutationObserver(()=>{if(restore())observer.disconnect();});observer.observe(root,{childList:true,subtree:true});
  }
})();
