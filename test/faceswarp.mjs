import fs from "node:fs"; import jpeg from "jpeg-js"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const cv = require("../opencv.js"); await new Promise(r=>{cv.onRuntimeInitialized=r;});
const RD = require("../detector.js");
const FILE=process.argv[2]||"userimg.jpg";
const img=jpeg.decode(fs.readFileSync(new URL("../"+FILE,import.meta.url)),{useTArray:true});
const W=img.width,H=img.height;const src=cv.matFromImageData({data:img.data,width:W,height:H});
// u2net mask
const rs=new cv.Mat();cv.resize(src,rs,new cv.Size(320,320),0,0,cv.INTER_AREA);
const rgb=new cv.Mat();cv.cvtColor(rs,rgb,cv.COLOR_RGBA2RGB);const d=rgb.data;
const mean=[0.485,0.456,0.406],std=[0.229,0.224,0.225];const inp=new Float32Array(3*320*320);
for(let i=0;i<320*320;i++)for(let c=0;c<3;c++)inp[c*320*320+i]=((d[i*3+c]/255)-mean[c])/std[c];
const sess=await ort.InferenceSession.create("./u2netp.onnx");
const out=await sess.run({[sess.inputNames[0]]:new ort.Tensor("float32",inp,[1,3,320,320])});
const sal=out[sess.outputNames[0]].data;let mn=1e9,mx=-1e9;for(const v of sal){if(v<mn)mn=v;if(v>mx)mx=v;}
const m320=new cv.Mat(320,320,cv.CV_8U);for(let i=0;i<320*320;i++)m320.data[i]=((sal[i]-mn)/(mx-mn))>0.5?255:0;
const cubeMask=new cv.Mat();cv.resize(m320,cubeMask,new cv.Size(W,H),0,0,cv.INTER_NEAREST);
const faces=RD.detectFacesGeometric(cv,src,{cubeMask});
console.log("faces",faces.length);
// save each warped face (300x300) into a montage + print reads
const S=300, mont=new Uint8Array(S*3*S*4);
faces.forEach((f,fi)=>{
  const q=f.corners;
  const srcT=cv.matFromArray(4,1,cv.CV_32FC2,[q[0].x,q[0].y,q[1].x,q[1].y,q[2].x,q[2].y,q[3].x,q[3].y]);
  const dstT=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,S,0,S,S,0,S]);
  const M=cv.getPerspectiveTransform(srcT,dstT);const warp=new cv.Mat();
  cv.warpPerspective(src,warp,M,new cv.Size(S,S),cv.INTER_LINEAR,cv.BORDER_REPLICATE,new cv.Scalar());
  // copy warp into montage column fi
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){const wi=(y*S+x)*4,mi=(y*(S*3)+(fi*S+x))*4;mont[mi]=warp.data[wi];mont[mi+1]=warp.data[wi+1];mont[mi+2]=warp.data[wi+2];mont[mi+3]=255;}
  // draw 3x3 grid lines on montage
  for(let g=1;g<3;g++)for(let t=0;t<S;t++){const xg=fi*S+(S/3*g)|0;mont[(t*(S*3)+xg)*4]=255;mont[(t*(S*3)+xg)*4+1]=255;mont[(t*(S*3)+xg)*4+2]=255;const yg=(S/3*g)|0;mont[(yg*(S*3)+(fi*S+t))*4]=255;mont[(yg*(S*3)+(fi*S+t))*4+1]=255;mont[(yg*(S*3)+(fi*S+t))*4+2]=255;}
  console.log(`face ${fi+1}:`,f.face.cells.map(c=>c.code).join(""));
  srcT.delete();dstT.delete();M.delete();warp.delete();
});
fs.writeFileSync(new URL("../tmp/faceswarp.jpg",import.meta.url),jpeg.encode({data:mont,width:S*3,height:S},92).data);
