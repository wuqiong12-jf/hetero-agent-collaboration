from pathlib import Path
from PIL import Image, ImageDraw

size = 256
image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 244, 244), radius=54, fill='#F6F3FA')
for x, color in [(48, '#9176B5'), (138, '#72A7B4')]:
    draw.rounded_rectangle((x, 64, x+70, 190), radius=14, fill=color)
    for y, width in [(89,29),(109,21)]:
        draw.line((x+20,y,x+20+width,y), fill='white', width=7)
        draw.ellipse((x+17,y-3,x+23,y+3), fill='white')
        draw.ellipse((x+17+width,y-3,x+23+width,y+3), fill='white')
    draw.ellipse((x+29,158,x+41,170), fill='white')
image.save(Path(__file__).parent/'relay-native'/'assets'/'icon.png')
