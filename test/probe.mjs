// Per cell: among vivid pixels (high s), take the dominant hue's average.
// Recovers a sticker color even when a finger/shadow covers part of the cell.
import fs from "node:fs";
import jpeg from "jpeg-js";
const img = jpeg.decode(fs.readFileSync(new URL("../sample.jpg", import.meta.url)), { useTArray: true });
const W = img.width, H = img.height, data = img.data;
const region = { x: 127, y: 285, w: 100, h: 100 };
const cw = region.w / 3, ch = region.h / 3;
function hsv(r,g,b){const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}return[h,mx?d/mx:0,mx/255];}
function classify(r,g,b){const[h,s,v]=hsv(r,g,b);if(s<0.22&&v>0.5)return"W";if(v<0.12)return"W";if(h<16||h>=330)return"R";if(h<48)return"O";if(h<70)return"Y";if(h<175)return"G";if(h<265)return"B";return"R";}

function cellColor(cx, cy, half) {
  const all = [];
  for (let y=(cy-half)|0; y<cy+half; y++) for (let x=(cx-half)|0; x<cx+half; x++) {
    if (x<0||y<0||x>=W||y>=H) continue;
    const i=(y*W+x)*4, r=data[i], g=data[i+1], b=data[i+2];
    const [h,s,v]=hsv(r,g,b); all.push({r,g,b,h,s,v});
  }
  // vivid pixels only; skin (~0.57) and shadow are comparatively dull
  const ST = +(process.argv[2] ?? 0.62);
  let vivid = all.filter(p => p.s>=ST && p.v>=0.4);
  if (vivid.length < all.length*0.05) vivid = all.slice(); // fallback: white/dull cell
  // dominant hue: 12 bins of 30°, but treat low-sat as white bin
  const bins = {};
  for (const p of vivid) { const key = (p.s<0.25&&p.v>0.5) ? "W" : (p.h/30|0); (bins[key]=bins[key]||[]).push(p); }
  let best=null; for (const k in bins) if (!best||bins[k].length>bins[best].length) best=k;
  const grp = bins[best];
  let r=0,g=0,b=0; for (const p of grp){r+=p.r;g+=p.g;b+=p.b;}
  return [r/grp.length,g/grp.length,b/grp.length,grp.length,vivid.length];
}
for(let gy=0;gy<3;gy++){let line="";for(let gx=0;gx<3;gx++){const cx=region.x+cw*(gx+0.5),cy=region.y+ch*(gy+0.5);const[R,G,B,n,tot]=cellColor(cx,cy,cw*0.28);line+=`(${gy},${gx}) ${classify(R,G,B)} rgb(${R|0},${G|0},${B|0}) ${n}/${tot}  `;}console.log(line);}
