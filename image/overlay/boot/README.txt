===============================================================================
 Tesla-Pi  --  Apple CarPlay and RetroArch in your Tesla's built-in browser
===============================================================================

You are looking at the boot partition of a freshly flashed Tesla-Pi card.
This is the only part of the card your computer can read, and the only file
here you should touch is:

    tesla-pi.txt

Open it in any text editor. It is commented and every setting is optional.


-------------------------------------------------------------------------------
 THE SHORT VERSION
-------------------------------------------------------------------------------

  1. Open tesla-pi.txt and set COUNTRY to your two-letter country code
     (GB, US, DE, AU, SG, ...). This is the only setting really worth
     filling in -- it decides which Wi-Fi channels the box may legally use.
     Leave it blank and it still works, just on slower 2.4 GHz.

  2. Eject the card and put it in the Raspberry Pi. Plug the Carlinkit
     dongle into a USB port. Power it up.

  3. In the car:  Wi-Fi  ->  join  Tesla-Pi-XXXX
     The default password is  12345678

  4. In the car's browser, go to:

         https://device.tesla-pi.humblebees.co

  5. CHANGE THE HOTSPOT PASSWORD. Settings -> Hotspot. The page will keep
     nagging you until you do, for good reason -- see below.

  6. Bookmark the page as a homepage favourite.


-------------------------------------------------------------------------------
 WHY THE PASSWORD MATTERS
-------------------------------------------------------------------------------

Nothing inside this box is password-protected. Every control -- CarPlay,
the settings pages, the hotspot configuration itself -- is open to anyone
who can join the Wi-Fi. That is a deliberate design decision: the hotspot
password IS the security boundary, and there is nothing behind it.

So while it is still set to 12345678, anyone parked near you can take over
the device, including changing the password out from under you.

The shipped password is trivial on purpose, because you need to be able to
reach the box before you can configure anything. It is not meant to survive
your first drive.


-------------------------------------------------------------------------------
 THE CERTIFICATE EXPIRES
-------------------------------------------------------------------------------

The box serves HTTPS, and its certificate is good for about 90 days. In the
car it needs no internet at all -- but to refresh that certificate it has to
reach the internet occasionally.

If you fill in HOME_WIFI_SSID and HOME_WIFI_PSK in tesla-pi.txt, it handles
this by itself: whenever it has been sitting idle for 10 minutes with nothing
connected (i.e. parked on your driveway), it briefly drops its own hotspot,
joins your home network, pulls a fresh certificate, and puts the hotspot back.

If you never give it a network, the certificate eventually expires and the
Tesla browser will refuse to load the page. The settings page warns you well
in advance, and you can fill this in later from Settings -> Wi-Fi.


-------------------------------------------------------------------------------
 SSH
-------------------------------------------------------------------------------

SSH is OFF. There is no default login. Two ways to turn it on, both described
in tesla-pi.txt:

  * drop a file called  authorized_keys  next to this one, containing your
    SSH public key  (recommended -- key auth only), or
  * set SSH_PASSWORD in tesla-pi.txt  (weaker)

Any password you put in tesla-pi.txt is erased from this partition once the
box has applied it, since anyone holding the card can read this partition.


-------------------------------------------------------------------------------
 IF SOMETHING GOES WRONG
-------------------------------------------------------------------------------

The hotspot does not appear
    Give it two minutes on the first boot -- it resizes its own filesystem
    and reboots. If it still does not appear, your COUNTRY setting may name
    a country whose rules forbid the channel it chose; blank it out and the
    box falls back to 2.4 GHz, which is allowed nearly everywhere.

The car has no Browser app at all
    Check Controls > Safety > Parental Controls. It can block Browser,
    Theater and Arcade outright. Nothing on the Pi can detect this.

The Tesla joins, then drops the network after a few seconds
    That is Tesla's connectivity probe failing. Plug in an Ethernet cable and
    see docs/captive-bypass-troubleshooting.md in the project repository.

The browser complains the certificate is not valid
    The certificate has expired. Connect the Pi to home Wi-Fi (see above).

To re-apply an edited tesla-pi.txt
    The settings here are applied once, on the very first boot. To make the
    box read them again, delete /var/lib/tesla-pi/.firstboot-done and reboot.


-------------------------------------------------------------------------------

  Project, source and full documentation:
      https://github.com/elwinchia/tesla-pi

  Read SECURITY.md before you put this in a car.

===============================================================================
