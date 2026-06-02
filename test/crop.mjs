import fs from "node:fs";
import jpeg from "jpeg-js";
const img = jpeg.decode(fs.readFileSync(new URL("../sample.jpg", import.meta.url)), { useTArray: true });
const W=img.width,H=img.height,d=img.data;
const rx=110,ry=280,rw=120,rh=120,sc=4;
const ow=rw*sc,oh=rh*sc,out=new Uint8Array(ow*oh*4);
for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){const sx=rx+(x/sc|0),sy=ry+(y/sc|0);const si=(sy*W+sx)*4,oi=(y*ow+x)*4;out[oi]=d[si];out[oi+1]=d[si+1];out[oi+2]=d[si+2];out[oi+3]=255;}
fs.writeFileSync(new URL("../crop.jpg", import.meta.url),jpeg.encode({data:out,width:ow,height:oh},95).data);
console.log("ok");
