from PIL import Image
a=Image.open('source-clothing.png').convert('RGBA')   # clothing source
b=Image.open('source-face.png').convert('RGBA')   # face/skin source
def copy(dst,src,box):
    dst.paste(src.crop(box),box[:2])
def clear(dst,box):
    dst.paste(Image.new('RGBA',(box[2]-box[0],box[3]-box[1]),(0,0,0,0)),box[:2])

out=a.copy()
copy(out,b,(0,0,32,16))            # base head: face, hair, skin tone
# hands: bottom 2 rows of each arm's sides + palm face, from skin 2
copy(out,b,(40,30,56,32)); copy(out,b,(48,16,52,20))   # right arm
copy(out,b,(32,62,48,64)); copy(out,b,(40,48,44,52))   # left arm
out.save('ender-hood-combined.png')
nohood=out.copy(); clear(nohood,(32,0,64,16))
nohood.save('ender-hood-combined-no-hood.png')
